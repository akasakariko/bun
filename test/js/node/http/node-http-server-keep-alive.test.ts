/**
 * All tests in this file run in both Bun and Node.js: `bun test` runs them
 * here, and the last test runs this same file under Node.js.
 *
 * llhttp keeps an HTTP/1.0 connection open for a request that has a keep-alive
 * item in Connection, and Node gives that verdict to the response:
 * https://github.com/nodejs/llhttp/blob/v9.4.2/src/native/http.c#L156-L170
 * https://github.com/nodejs/node/blob/v26.3.0/lib/_http_server.js#L1293
 * _storeHeader then keeps the connection open behind a response that has a
 * Content-Length, and closes it behind a body that has none:
 * https://github.com/nodejs/node/blob/v26.3.0/lib/_http_outgoing.js#L500-L549
 */
import assert from "node:assert";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { connect, createServer as createNetServer } from "node:net";
import { describe, test } from "node:test";
import { connect as connectTLS } from "node:tls";
import { fileURLToPath } from "node:url";

type Listener = (req: http.IncomingMessage, res: http.ServerResponse) => void;
type Transport = "tcp" | "tls" | "connection event";
type Options = {
  transport?: Transport;
  /** All requests go out in one write. */
  pipelined?: boolean;
  server?: http.ServerOptions;
  prepare?: (server: http.Server) => void;
  /** Do not wait for the server to end the connection. */
  leave?: boolean;
};

const fixture = (name: string) => readFileSync(new URL(`../test/fixtures/keys/${name}`, import.meta.url));

/** A raw client. It reads one response at a time, by the framing of the response itself. */
class Peer {
  #socket: Socket;
  #bytes = "";
  #failure: Error | undefined;
  #wake = () => {};
  ended = false;

  constructor(socket: Socket) {
    this.#socket = socket;
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => {
      this.#bytes += chunk;
      this.#wake();
    });
    socket.on("end", () => {
      this.ended = true;
      this.#wake();
    });
    socket.on("error", err => {
      this.#failure = err;
      this.#wake();
    });
  }

  send(bytes: string) {
    this.#socket.write(bytes, "latin1");
  }

  destroy() {
    this.#socket.destroy();
  }

  /** Waits for `length(bytes)` bytes. False when the server ends the connection first. */
  async #have(length: (bytes: string) => number) {
    for (;;) {
      const wanted = length(this.#bytes);
      if (wanted >= 0 && this.#bytes.length >= wanted) return true;
      if (this.#failure) throw this.#failure;
      if (this.ended) return false;
      await new Promise<void>(resolve => (this.#wake = resolve));
    }
  }

  #take(length = this.#bytes.length) {
    const taken = this.#bytes.slice(0, length);
    this.#bytes = this.#bytes.slice(length);
    return taken;
  }

  /** The next response. Without a Content-Length, its body is all bytes until the server ends the connection. */
  async response(method: string) {
    const endOfHead = (bytes: string) => bytes.indexOf("\r\n\r\n") + 4 || -1;
    if (!(await this.#have(endOfHead))) return this.#take();
    const head = this.#take(endOfHead(this.#bytes));
    const status = head.slice(9, 12);
    const length = /\r\nContent-Length: (\d+)\r\n/i.exec(head)?.[1];
    let body = "";
    if (method !== "HEAD" && status !== "204" && status !== "304") {
      await this.#have(() => (length === undefined ? -1 : Number(length)));
      body = this.#take(length === undefined ? undefined : Number(length));
    }
    return head.replace(/\r\nDate: [^\r]*/, "\r\nDate: <date>") + body;
  }

  /** "end" when the server ended the connection and sent nothing more. */
  async over() {
    await this.#have(() => -1);
    return this.#take() + "end";
  }
}

/** Sends the requests on one connection. Returns the responses, then "end" when the server ended the connection. */
async function exchange(listener: Listener, requests: string[], options: Options = {}) {
  const { transport = "tcp" } = options;
  const secure = transport === "tls";
  const server: http.Server = secure
    ? https.createServer({ ...options.server, key: fixture("agent1-key.pem"), cert: fixture("agent1-cert.pem") })
    : http.createServer({ ...options.server });
  server.on("request", listener);
  options.prepare?.(server);
  // The transport "connection event" gives the server a socket that another server accepted.
  const acceptor =
    transport === "connection event" ? createNetServer(socket => server.emit("connection", socket)) : server;
  acceptor.listen(0, "127.0.0.1");
  await once(acceptor, "listening");
  const { port } = acceptor.address() as AddressInfo;
  const socket = secure
    ? connectTLS({ port, host: "127.0.0.1", rejectUnauthorized: false })
    : connect(port, "127.0.0.1");
  const peer = new Peer(socket);
  try {
    await once(socket, secure ? "secureConnect" : "connect");
    const out: string[] = [];
    if (options.pipelined) peer.send(requests.join(""));
    for (const request of requests) {
      if (peer.ended) break;
      if (!options.pipelined) peer.send(request);
      out.push(await peer.response(request.slice(0, request.indexOf(" "))));
    }
    if (!options.leave) out.push(await peer.over());
    return out;
  } finally {
    peer.destroy();
    server.closeAllConnections();
    server.close();
    if (acceptor !== server) acceptor.close();
  }
}

const asksToPersist = (path: string, fields = "Connection: keep-alive\r\n", version = "1.0") =>
  `GET ${path} HTTP/${version}\r\nHost: x\r\n${fields}\r\n`;
/** An HTTP/1.0 request that does not ask for a persistent connection: the server closes it after the response. */
const last = "GET /last HTTP/1.0\r\nHost: x\r\n\r\n";

const persists = "Connection: keep-alive\r\nKeep-Alive: timeout=5\r\n";
const closes = "Connection: close\r\n";
const ok = (body: string, connection: string, length = body.length) =>
  `HTTP/1.1 200 OK\r\nContent-Length: ${length}\r\nDate: <date>\r\n${connection}\r\n${body}`;

/** Answers with the URL, and with its length in Content-Length. */
const withLength: Listener = (req, res) => {
  res.writeHead(200, { "Content-Length": req.url!.length });
  res.end(req.url);
};
/** Answers with the URL, and without a Content-Length. */
const withoutLength: Listener = (req, res) => {
  res.end(req.url);
};
/** The request `last` gets the answer of withLength. */
const butLast =
  (listener: Listener): Listener =>
  (req, res) =>
    (req.url === "/last" ? withLength : listener)(req, res);
const later =
  (listener: Listener): Listener =>
  (req, res) =>
    void setImmediate(listener, req, res);

describe("an HTTP/1.0 request with Connection: keep-alive", () => {
  describe("keeps the connection open behind a response with a Content-Length", () => {
    const requests: [name: string, request: string][] = [
      ["Connection: keep-alive", asksToPersist("/1")],
      ["Connection: Keep-Alive, TE", asksToPersist("/1", "Connection: Keep-Alive, TE\r\n")],
      ["Connection: keep-alive, close", asksToPersist("/1", "Connection: keep-alive, close\r\n")],
      ["two Connection fields", asksToPersist("/1", "Connection: close\r\nConnection: keep-alive\r\n")],
      ["Proxy-Connection: keep-alive", asksToPersist("/1", "Proxy-Connection: keep-alive\r\n")],
      ["no Host field", "GET /1 HTTP/1.0\r\nConnection: keep-alive\r\n\r\n"],
    ];
    for (const [name, request] of requests) {
      for (const transport of ["tcp", "tls"] as const) {
        test(`${name} (${transport})`, async () => {
          assert.deepStrictEqual(await exchange(withLength, [request, last], { transport }), [
            ok("/1", persists),
            ok("/last", closes),
            "end",
          ]);
        });
      }
    }

    test("a request with a body", async () => {
      const echo: Listener = (req, res) => {
        let body = req.url + " ";
        req.setEncoding("latin1");
        req.on("data", chunk => (body += chunk));
        req.on("end", () => {
          res.writeHead(200, { "Content-Length": body.length });
          res.end(body);
        });
      };
      const post = "POST /1 HTTP/1.0\r\nHost: x\r\nConnection: keep-alive\r\nContent-Length: 3\r\n\r\nabc";
      assert.deepStrictEqual(await exchange(echo, [post, asksToPersist("/2"), last]), [
        ok("/1 abc", persists),
        ok("/2 ", persists),
        ok("/last ", closes),
        "end",
      ]);
    });

    const listeners: [name: string, listener: Listener, response: string, method?: string][] = [
      [
        "writeHead(), write() and end()",
        (req, res) => {
          res.writeHead(200, { "Content-Length": 5 });
          res.write("he");
          res.end("llo");
        },
        ok("hello", persists),
      ],
      [
        "flushHeaders() before end()",
        (req, res) => {
          res.setHeader("Content-Length", 5);
          res.flushHeaders();
          res.end("hello");
        },
        ok("hello", persists),
      ],
      [
        "a listener that answers later",
        later((req, res) => {
          res.setHeader("Content-Length", 5);
          res.end("hello");
        }),
        ok("hello", persists),
      ],
      [
        "an empty body",
        (req, res) => {
          res.setHeader("Content-Length", 0);
          res.end();
        },
        ok("", persists),
      ],
      [
        "a 204",
        (req, res) => {
          res.writeHead(204, { "Content-Length": 0 });
          res.end();
        },
        `HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nDate: <date>\r\n${persists}\r\n`,
      ],
      ["a HEAD request", withLength, ok("", persists, 2), "HEAD"],
      [
        "a Connection: keep-alive header of the listener",
        (req, res) => {
          res.setHeader("Connection", "keep-alive");
          res.setHeader("Content-Length", 5);
          res.end("hello");
        },
        "HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Length: 5\r\nDate: <date>\r\n\r\nhello",
      ],
      [
        "a Connection header that the listener removed",
        (req, res) => {
          res.removeHeader("Connection");
          res.setHeader("Content-Length", 5);
          res.end("hello");
        },
        "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nDate: <date>\r\n\r\nhello",
      ],
    ];
    for (const [name, listener, response, method = "GET"] of listeners) {
      test(name, async () => {
        const request = `${method} /1 HTTP/1.0\r\nHost: x\r\nConnection: keep-alive\r\n\r\n`;
        assert.deepStrictEqual(await exchange(butLast(listener), [request, last]), [
          response,
          ok("/last", closes),
          "end",
        ]);
      });
    }
  });

  describe("keeps the connection open behind a response that has no body and no Content-Length", () => {
    // _storeHeader closes such a connection when it writes the Connection header itself.
    const listeners: [name: string, listener: Listener, response: string, method?: string][] = [
      [
        "a 204 with a Connection: keep-alive header of the listener",
        (req, res) => {
          res.writeHead(204, { Connection: "keep-alive" });
          res.end();
        },
        "HTTP/1.1 204 No Content\r\nConnection: keep-alive\r\nDate: <date>\r\n\r\n",
      ],
      [
        "a 304 with a Connection header that the listener removed",
        (req, res) => {
          res.removeHeader("Connection");
          res.statusCode = 304;
          res.end();
        },
        "HTTP/1.1 304 Not Modified\r\nDate: <date>\r\n\r\n",
      ],
      [
        "a HEAD request with a Connection: keep-alive header of the listener",
        (req, res) => {
          res.setHeader("Connection", "keep-alive");
          res.end();
        },
        "HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nDate: <date>\r\n\r\n",
        "HEAD",
      ],
    ];
    for (const [name, listener, response, method = "GET"] of listeners) {
      test(name, async () => {
        const request = `${method} /1 HTTP/1.0\r\nHost: x\r\nConnection: keep-alive\r\n\r\n`;
        assert.deepStrictEqual(await exchange(butLast(listener), [request, last]), [
          response,
          ok("/last", closes),
          "end",
        ]);
      });
    }
  });

  test("shares a connection with HTTP/1.1 requests", async () => {
    const requests = [
      asksToPersist("/1", "", "1.1"),
      asksToPersist("/2"),
      asksToPersist("/3", "", "1.1"),
      asksToPersist("/4"),
      last,
    ];
    assert.deepStrictEqual(await exchange(withLength, requests), [
      ok("/1", persists),
      ok("/2", persists),
      ok("/3", persists),
      ok("/4", persists),
      ok("/last", closes),
      "end",
    ]);
  });

  describe("with pipelined requests", () => {
    for (const [when, timing] of [
      ["at once", (listener: Listener) => listener],
      ["later", later],
    ] as const) {
      test(`gets every response, from a listener that answers ${when}`, async () => {
        const requests = [asksToPersist("/1"), asksToPersist("/2"), asksToPersist("/3"), last];
        assert.deepStrictEqual(await exchange(timing(withLength), requests, { pipelined: true }), [
          ok("/1", persists),
          ok("/2", persists),
          ok("/3", persists),
          ok("/last", closes),
          "end",
        ]);
      });

      test(`gets no response behind one without a Content-Length, from a listener that answers ${when}`, async () => {
        const listener: Listener = (req, res) => (req.url === "/2" ? withoutLength : withLength)(req, res);
        const requests = [asksToPersist("/1"), asksToPersist("/2"), asksToPersist("/3")];
        assert.deepStrictEqual(await exchange(timing(listener), requests, { pipelined: true }), [
          ok("/1", persists),
          `HTTP/1.1 200 OK\r\nDate: <date>\r\n${closes}\r\n/2`,
          "end",
        ]);
      });
    }
  });

  describe("with a limit of the server", () => {
    test("maxRequestsPerSocket is in Keep-Alive, and the request does not count", async () => {
      const requests = [asksToPersist("/1"), asksToPersist("/2"), asksToPersist("/3"), last];
      const out = await exchange(withLength, requests, { prepare: server => (server.maxRequestsPerSocket = 2) });
      // Bun writes Date behind Keep-Alive when the header has `max`, also for HTTP/1.1.
      const sorted = (response: string) => {
        const [head, body] = response.split("\r\n\r\n");
        return [...head.split("\r\n").sort(), body];
      };
      const counted = "Connection: keep-alive\r\nKeep-Alive: timeout=5, max=2\r\n";
      assert.deepStrictEqual(
        out.map(sorted),
        [ok("/1", counted), ok("/2", counted), ok("/3", counted), ok("/last", closes), "end"].map(sorted),
      );
    });

    test("keepAliveTimeout closes the idle connection", async () => {
      const prepare = (server: http.Server) => {
        server.keepAliveTimeout = 50;
        server.keepAliveTimeoutBuffer = 0;
      };
      assert.deepStrictEqual(await exchange(withLength, [asksToPersist("/1")], { prepare }), [
        ok("/1", "Connection: keep-alive\r\nKeep-Alive: timeout=0\r\n"),
        "end",
      ]);
    });

    test("keepAliveTimeout = 0 sends no Keep-Alive header", async () => {
      const prepare = (server: http.Server) => (server.keepAliveTimeout = 0);
      assert.deepStrictEqual(await exchange(withLength, [asksToPersist("/1"), last], { prepare }), [
        ok("/1", "Connection: keep-alive\r\n"),
        ok("/last", closes),
        "end",
      ]);
    });
  });

  describe("closes the connection", () => {
    const listeners: [name: string, listener: Listener, response: string, method?: string][] = [
      [
        "behind end(data) without a Content-Length",
        withoutLength,
        `HTTP/1.1 200 OK\r\nDate: <date>\r\n${closes}\r\n/1`,
      ],
      [
        "behind write() and end() without a Content-Length",
        (req, res) => {
          res.write("he");
          res.end("llo");
        },
        `HTTP/1.1 200 OK\r\nDate: <date>\r\n${closes}\r\nhello`,
      ],
      [
        "behind writeHead() without a Content-Length",
        (req, res) => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("hello");
        },
        `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nDate: <date>\r\n${closes}\r\nhello`,
      ],
      ["behind an empty end()", (req, res) => void res.end(), `HTTP/1.1 200 OK\r\nDate: <date>\r\n${closes}\r\n`],
      [
        "behind a 204 without a Content-Length",
        (req, res) => {
          res.statusCode = 204;
          res.end();
        },
        `HTTP/1.1 204 No Content\r\nDate: <date>\r\n${closes}\r\n`,
      ],
      [
        "behind a HEAD response without a Content-Length",
        withoutLength,
        `HTTP/1.1 200 OK\r\nDate: <date>\r\n${closes}\r\n`,
        "HEAD",
      ],
      [
        "when the listener removed Connection and the body has no Content-Length",
        (req, res) => {
          res.removeHeader("Connection");
          res.end("hello");
        },
        "HTTP/1.1 200 OK\r\nDate: <date>\r\n\r\nhello",
      ],
      [
        "when the listener sets res.shouldKeepAlive = false",
        (req, res) => {
          res.shouldKeepAlive = false;
          withLength(req, res);
        },
        ok("/1", closes),
      ],
      [
        "when the listener sets Connection: close",
        (req, res) => {
          res.setHeader("Connection", "close");
          res.setHeader("Content-Length", 5);
          res.end("hello");
        },
        "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 5\r\nDate: <date>\r\n\r\nhello",
      ],
    ];
    for (const [name, listener, response, method = "GET"] of listeners) {
      test(name, async () => {
        const request = `${method} /1 HTTP/1.0\r\nHost: x\r\nConnection: keep-alive\r\n\r\n`;
        assert.deepStrictEqual(await exchange(listener, [request]), [response, "end"]);
      });
    }
  });
});

describe("an HTTP/1.0 request without a keep-alive item in Connection closes the connection", () => {
  const requests: [name: string, fields: string][] = [
    ["no Connection field", ""],
    ["Connection: close", "Connection: close\r\n"],
    ["Connection: TE", "Connection: TE\r\n"],
    ["Connection: keep-alive-x", "Connection: keep-alive-x\r\n"],
    ["Keep-Alive: timeout=5 only", "Keep-Alive: timeout=5\r\n"],
  ];
  for (const [name, fields] of requests) {
    for (const transport of ["tcp", "tls"] as const) {
      test(`${name} (${transport})`, async () => {
        assert.deepStrictEqual(await exchange(withLength, [asksToPersist("/1", fields)], { transport }), [
          ok("/1", closes),
          "end",
        ]);
      });
    }
  }
});

describe("res.shouldKeepAlive is the verdict of the parser on the request", () => {
  const verdicts: [version: string, fields: string, shouldKeepAlive: boolean][] = [
    ["1.1", "", true],
    ["1.1", "Connection: keep-alive\r\n", true],
    ["1.1", "Connection: close\r\n", false],
    ["1.1", "Connection: keep-alive, close\r\n", false],
    ["1.1", "Connection: keep-alive\r\nConnection: close\r\n", false],
    ["1.1", "Proxy-Connection: close\r\n", false],
    ["1.1", "Connection: closed\r\n", true],
    ["1.0", "", false],
    ["1.0", "Connection: keep-alive\r\n", true],
    ["1.0", "Connection: KEEP-ALIVE\r\n", true],
    ["1.0", "Connection: close\r\n", false],
    ["1.0", "Connection: keep-alive, close\r\n", true],
    ["1.0", "Connection: close\r\nConnection: keep-alive\r\n", true],
    ["1.0", "Proxy-Connection: keep-alive\r\n", true],
    ["1.0", "Connection: keep-alive-x\r\n", false],
  ];
  for (const [version, fields, shouldKeepAlive] of verdicts) {
    test(`HTTP/${version} ${JSON.stringify(fields)}`, async () => {
      const seen: boolean[] = [];
      const listener: Listener = (req, res) => {
        seen.push(res.shouldKeepAlive);
        withLength(req, res);
      };
      const out = await exchange(listener, [asksToPersist("/1", fields, version)], { leave: true });
      assert.deepStrictEqual(
        { seen, out },
        { seen: [shouldKeepAlive], out: [ok("/1", shouldKeepAlive ? persists : closes)] },
      );
    });
  }

  test("a class from the ServerResponse option gets it after its constructor", async () => {
    const seen: boolean[] = [];
    class Response extends http.ServerResponse {
      constructor(req: http.IncomingMessage, options?: object) {
        // @ts-expect-error Node.js passes the options of the response as a second argument.
        super(req, options);
        this.shouldKeepAlive = false;
      }
    }
    const listener: Listener = (req, res) => {
      seen.push(res instanceof Response, res.shouldKeepAlive);
      withLength(req, res);
    };
    const requests = [asksToPersist("/1", "", "1.1"), asksToPersist("/2"), last];
    const out = await exchange(listener, requests, { server: { ServerResponse: Response } });
    assert.deepStrictEqual(
      { seen, out },
      {
        seen: [true, true, true, true, true, false],
        out: [ok("/1", persists), ok("/2", persists), ok("/last", closes), "end"],
      },
    );
  });
});

// Only in Bun: when Node.js runs this file it must not spawn itself again.
if (typeof Bun !== "undefined") {
  const { bunEnv, nodeExe } = await import("harness");
  const node = nodeExe();

  // Node.js keeps each of these connections open. Bun's native writer sends no
  // chunks to an HTTP/1.0 request, and its other transport has no timer that
  // closes an idle connection.
  describe("an HTTP/1.0 request with Connection: keep-alive still closes the connection in Bun", () => {
    const answers = async (listener: Listener, request: string, options?: Options) => {
      const out = await exchange(listener, [request], options);
      return { responses: out.length - 1, body: out[0].slice(out[0].indexOf("\r\n\r\n") + 4), then: out.at(-1) };
    };

    test("behind a response to a request with TE: chunked", async () => {
      const request = asksToPersist("/1", "Connection: keep-alive\r\nTE: chunked\r\n");
      assert.deepStrictEqual(await answers(withoutLength, request), { responses: 1, body: "/1", then: "end" });
    });

    test("behind a response with a Transfer-Encoding header of the listener", async () => {
      const listener: Listener = (req, res) => {
        res.setHeader("Transfer-Encoding", "chunked");
        res.end();
      };
      assert.deepStrictEqual(await answers(listener, asksToPersist("/1")), { responses: 1, body: "", then: "end" });
    });

    test("when the request has a Transfer-Encoding field (RFC 9112 6.1)", async () => {
      const seen: (boolean | string)[] = [];
      const listener: Listener = (req, res) => {
        seen.push(res.shouldKeepAlive);
        req.setEncoding("latin1");
        req.on("data", chunk => seen.push(chunk));
        req.on("end", () => withLength(req, res));
      };
      for (const coding of ["chunked", ""]) {
        const body = coding === "chunked" ? "3\r\nabc\r\n0\r\n\r\n" : "";
        const request = `POST /1 HTTP/1.0\r\nHost: x\r\nConnection: keep-alive\r\nTransfer-Encoding: ${coding}\r\n\r\n${body}`;
        assert.deepStrictEqual(await exchange(listener, [request]), [ok("/1", closes), "end"]);
      }
      assert.deepStrictEqual(seen, [false, "abc", false]);
    });

    test("on a connection from emit('connection')", async () => {
      assert.deepStrictEqual(await exchange(withLength, [asksToPersist("/1")], { transport: "connection event" }), [
        ok("/1", closes),
        "end",
      ]);
    });
  });

  describe("Node.js compatibility", () => {
    (node ? test : test.skip)("all tests pass in Node.js", async () => {
      // A direct run, not `node --test`: the runner mode forks a second node
      // process per file. node:test still exits non-zero on any failure.
      await using proc = Bun.spawn({
        cmd: [node!, "--v8-pool-size=1", fileURLToPath(import.meta.url)],
        env: { ...bunEnv, UV_THREADPOOL_SIZE: "2" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      assert.deepStrictEqual({ exitCode, output: exitCode === 0 ? "" : stdout + stderr }, { exitCode: 0, output: "" });
    });
  });
}
