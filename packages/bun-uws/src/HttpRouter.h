/*
 * Authored by Alex Hultman, 2018-2020.
 * Intellectual property of third-party.

 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at

 *     http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#ifndef UWS_HTTPROUTER_HPP
#define UWS_HTTPROUTER_HPP

#include <cstdint>
#include <map>
#include <vector>
#include <cstring>
#include <string_view>
#include <string>
#include <algorithm>
#include <memory>
#include <utility>
#include <span>

#include "MoveOnlyFunction.h"

namespace uWS {

template <typename UserDataType>
struct HttpRouter {
    static constexpr std::string_view ANY_METHOD_TOKEN = "*";
    static constexpr uint32_t HIGH_PRIORITY = 0xd0000000, MEDIUM_PRIORITY = 0xe0000000, LOW_PRIORITY = 0xf0000000;

private:
    UserDataType userData;
    static constexpr unsigned int MAX_URL_SEGMENTS = 100;

    /* Handler ids are 32-bit */
    static constexpr uint32_t HANDLER_MASK = 0x0fffffff;

    /* List of handlers */
    std::vector<MoveOnlyFunction<bool(HttpRouter *)>> handlers;

    /* Current URL cache */
    std::string_view currentUrl = {};
    std::string_view urlSegmentVector[MAX_URL_SEGMENTS] = {};
    int urlSegmentTop = -1;

    static constexpr uint32_t NONE = UINT32_MAX;
    static constexpr uint32_t ROOT = 0;
    static constexpr uint32_t CHILD_LIST_HEADER = 4;
    /* A run of static children this short is scanned by name, as hashing the
     * segment costs more than the few compares */
    static constexpr uint32_t SCANNED_RUN = 4;

    /* The matching tree, stored flat. Nodes name their parent by index and
     * nothing points at a node, so `nodes` can grow and be compacted freely.
     *
     * add() appends nodes and finds an existing child through `lookup`, a hash
     * index over (parent, priority tier, name), so registration is O(1) per
     * segment. sortChildren() then lays every child list out in `edges` and
     * frees `lookup`; route() binary-searches the sorted lists. */
    struct Node {
        /* The name is names[nameOffset, nameOffset + nameLength). One add()
         * stores a segment once and the node of every method shares it. */
        uint32_t nameOffset;
        uint32_t nameLength;
        uint32_t parent;
        /* Head of this node's handlers in handlerLinks, ordered by priority */
        uint32_t firstHandler;
        /* Offset of this node's child list in edges, NONE for a leaf */
        uint32_t childList;
        /* Live children. A node with no handler and no child is dropped. */
        uint32_t children : 30;
        uint32_t isHighPriority : 1;
        uint32_t dead : 1;
    };

    struct HandlerLink {
        uint32_t handler;
        uint32_t next;
    };

    std::vector<Node> nodes;
    std::vector<char> names;
    std::vector<HandlerLink> handlerLinks;
    uint32_t freeHandlerLink = NONE;
    uint32_t deadNodes = 0;
    /* The method nodes, which are the live children of the root */
    std::vector<uint32_t> methodNodes;
    /* A removed handler leaves an empty slot in handlers until the next sort,
     * so that a removal does not renumber every handler after it */
    uint32_t removedHandlers = 0;

    /* One list per node that has children: four counts (high static, high
     * special, normal static, normal special), then the children in that
     * order. This is the order the children are tried in: high priority
     * before normal, and within a priority a static name, then ':', then '*'.
     * A run of static children is its name hashes, sorted, followed by the
     * children in the same order, so a search stays inside one run of
     * integers and reads a node only to confirm the match. */
    std::vector<uint32_t> edges;
    bool sorted = false;

    /* Open addressing over node indices. Empty means not built. */
    std::vector<uint32_t> lookup;
    uint32_t lookupCount = 0;

    /* True when edges is current and lookup is freed */
    bool ready = false;

    /* Most requests are GET, and the last method is tried for every request
     * that no method route took, so route() does not search for either */
    uint32_t getMethod = NONE;
    uint32_t lastMethod = NONE;

    std::string_view nameOf(const Node &node) const {
        return {names.data() + node.nameOffset, node.nameLength};
    }

    /* A ':' or '*' segment matches by rule, every other name (the empty
     * segment of "//" too) matches itself. Methods always match themselves. */
    static bool isSpecialName(std::string_view name) {
        return !name.empty() && (name[0] == ':' || name[0] == '*');
    }

    static uint64_t hashWord(uint64_t hash, uint64_t word) {
        hash = (hash ^ word) * 0xff51afd7ed558ccdull;
        return hash ^ (hash >> 32);
    }

    static uint64_t hashBytes(std::string_view name) {
        const char *data = name.data();
        size_t size = name.size();
        uint64_t hash = size * 0x9e3779b97f4a7c15ull;
        if (size >= 8) {
            /* Whole words, then the last eight bytes, which can overlap */
            uint64_t word;
            for (; size > 8; data += 8, size -= 8) {
                memcpy(&word, data, 8);
                hash = hashWord(hash, word);
            }
            memcpy(&word, data + size - 8, 8);
            return hashWord(hash, word);
        }
        if (size >= 4) {
            uint32_t head, tail;
            memcpy(&head, data, 4);
            memcpy(&tail, data + size - 4, 4);
            return hashWord(hash, ((uint64_t) head << 32) | tail);
        }
        if (size) {
            uint64_t word = ((uint64_t) (unsigned char) data[0] << 16) | ((uint64_t) (unsigned char) data[size / 2] << 8) | (unsigned char) data[size - 1];
            return hashWord(hash, word);
        }
        return hash;
    }

    static uint32_t hashName(std::string_view name) {
        return (uint32_t) hashBytes(name);
    }

    static uint64_t hashKey(uint32_t parent, bool isHighPriority, std::string_view name) {
        uint64_t hash = hashBytes(name);
        hash ^= (((uint64_t) parent << 1) | (uint64_t) isHighPriority) * 0x9e3779b97f4a7c15ull;
        hash ^= hash >> 29;
        hash *= 0xbf58476d1ce4e5b9ull;
        hash ^= hash >> 32;
        return hash;
    }

    uint32_t lookupFind(uint32_t parent, std::string_view name, bool isHighPriority) const {
        size_t mask = lookup.size() - 1;
        for (size_t i = hashKey(parent, isHighPriority, name) & mask;; i = (i + 1) & mask) {
            uint32_t candidate = lookup[i];
            if (candidate == NONE) {
                return NONE;
            }
            const Node &node = nodes[candidate];
            if (node.parent == parent && node.isHighPriority == isHighPriority && nameOf(node) == name) {
                return candidate;
            }
        }
    }

    void lookupInsert(uint32_t index) {
        const Node &node = nodes[index];
        size_t mask = lookup.size() - 1;
        size_t i = hashKey(node.parent, node.isHighPriority, nameOf(node)) & mask;
        while (lookup[i] != NONE) {
            i = (i + 1) & mask;
        }
        lookup[i] = index;
        lookupCount++;
    }

    /* Takes a node out of the index. The entries after it in its probe run move
     * back, so that a search still reaches them. */
    void lookupErase(uint32_t index) {
        size_t mask = lookup.size() - 1;
        const Node &node = nodes[index];
        size_t hole = hashKey(node.parent, node.isHighPriority, nameOf(node)) & mask;
        while (lookup[hole] != index) {
            hole = (hole + 1) & mask;
        }
        for (size_t next = (hole + 1) & mask; lookup[next] != NONE; next = (next + 1) & mask) {
            const Node &moved = nodes[lookup[next]];
            size_t home = hashKey(moved.parent, moved.isHighPriority, nameOf(moved)) & mask;
            if (((next - home) & mask) >= ((next - hole) & mask)) {
                lookup[hole] = lookup[next];
                hole = next;
            }
        }
        lookup[hole] = NONE;
        lookupCount--;
    }

    void rebuildLookup(size_t capacity) {
        lookup.assign(capacity, NONE);
        lookupCount = 0;
        for (uint32_t i = 1; i < nodes.size(); i++) {
            if (!nodes[i].dead) {
                lookupInsert(i);
            }
        }
    }

    void ensureLookup() {
        if (!lookup.empty()) {
            return;
        }
        size_t capacity = 16;
        while (capacity * 3 < (nodes.size() - deadNodes) * 4) {
            capacity *= 2;
        }
        rebuildLookup(capacity);
        ready = false;
    }

    /* Searches one run of static children */
    uint32_t findStatic(uint32_t first, uint32_t count, std::string_view name) const {
        const uint32_t *hashes = edges.data() + first;
        const uint32_t *children = hashes + count;
        if (count <= SCANNED_RUN) {
            for (uint32_t i = 0; i < count; i++) {
                if (nameOf(nodes[children[i]]) == name) {
                    return children[i];
                }
            }
            return NONE;
        }
        uint32_t hash = hashName(name);
        uint32_t low = 0;
        for (uint32_t size = count; size;) {
            uint32_t half = size / 2;
            if (hashes[low + half] < hash) {
                low += half + 1;
                size -= half + 1;
            } else {
                size = half;
            }
        }
        for (; low < count && hashes[low] == hash; low++) {
            if (nameOf(nodes[children[low]]) == name) {
                return children[low];
            }
        }
        return NONE;
    }

    uint32_t sortedFind(uint32_t parent, std::string_view name, bool isHighPriority) const {
        uint32_t list = nodes[parent].childList;
        if (list == NONE) {
            return NONE;
        }
        uint32_t first = list + CHILD_LIST_HEADER;
        if (!isHighPriority) {
            first += edges[list] * 2 + edges[list + 1];
        }
        uint32_t statics = edges[list + (isHighPriority ? 0 : 2)];
        uint32_t specials = edges[list + (isHighPriority ? 1 : 3)];
        if (parent == ROOT || !isSpecialName(name)) {
            return findStatic(first, statics, name);
        }
        for (uint32_t i = first + statics * 2; i < first + statics * 2 + specials; i++) {
            if (nameOf(nodes[edges[i]]) == name) {
                return edges[i];
            }
        }
        return NONE;
    }

    /* Finds an existing child by exact name */
    uint32_t findChild(uint32_t parent, std::string_view name, bool isHighPriority) {
        if (lookup.empty() && sorted) {
            return sortedFind(parent, name, isHighPriority);
        }
        ensureLookup();
        return lookupFind(parent, name, isHighPriority);
    }

    /* Advance from parent to child, adding child if necessary. stored is where
     * this add() already put the name, or NONE. */
    uint32_t getNode(uint32_t parent, std::string_view child, bool isHighPriority, uint32_t &stored) {
        ensureLookup();
        uint32_t existing = lookupFind(parent, child, isHighPriority);
        if (existing != NONE) {
            return existing;
        }
        if (((size_t) lookupCount + 1) * 4 > lookup.size() * 3) {
            rebuildLookup(lookup.size() * 2);
        }
        if (stored == NONE) {
            stored = (uint32_t) names.size();
            names.insert(names.end(), child.begin(), child.end());
        }
        uint32_t index = (uint32_t) nodes.size();
        nodes.push_back({stored, (uint32_t) child.size(), parent, NONE, NONE, 0, isHighPriority, false});
        nodes[parent].children++;
        if (parent == ROOT) {
            methodNodes.push_back(index);
        }
        lookupInsert(index);
        sorted = false;
        return index;
    }

    /* Drops the node if it has no handler and no child, and then its parent */
    void dropIfEmpty(uint32_t index) {
        while (index != ROOT) {
            Node &node = nodes[index];
            if (node.firstHandler != NONE || node.children) {
                return;
            }
            if (!lookup.empty()) {
                lookupErase(index);
            }
            node.dead = true;
            deadNodes++;
            sorted = false;
            uint32_t parent = node.parent;
            nodes[parent].children--;
            if (parent == ROOT) {
                methodNodes.erase(std::find(methodNodes.begin(), methodNodes.end(), index));
            }
            index = parent;
        }
    }

    /* Drops dead nodes. A child always has a higher index than its parent and a
     * live node has a live parent, so one forward pass renumbers everything. */
    void compact() {
        if (!deadNodes) {
            return;
        }
        std::vector<uint32_t> moved(nodes.size());
        uint32_t live = 0;
        for (uint32_t i = 0; i < nodes.size(); i++) {
            if (nodes[i].dead) {
                continue;
            }
            moved[i] = live;
            if (i != ROOT) {
                nodes[i].parent = moved[nodes[i].parent];
            }
            if (live != i) {
                nodes[live] = std::move(nodes[i]);
            }
            live++;
        }
        nodes.erase(nodes.begin() + live, nodes.end());
        deadNodes = 0;
        for (uint32_t &method : methodNodes) {
            method = moved[method];
        }

        /* Keep the names that a live node still uses. Nodes share names, so
         * each one moves once. */
        std::vector<uint32_t> movedName(names.size(), NONE);
        std::vector<char> kept;
        for (Node &node : nodes) {
            if (!node.nameLength) {
                node.nameOffset = 0;
                continue;
            }
            uint32_t &to = movedName[node.nameOffset];
            if (to == NONE) {
                to = (uint32_t) kept.size();
                kept.insert(kept.end(), names.begin() + node.nameOffset, names.begin() + node.nameOffset + node.nameLength);
            }
            node.nameOffset = to;
        }
        names = std::move(kept);
    }

    void buildEdges() {
        /* The child count of each node, then where its next child goes */
        std::vector<uint32_t> cursor(nodes.size(), 0);
        uint32_t parents = 0;
        uint32_t statics = 0;
        for (uint32_t i = 1; i < nodes.size(); i++) {
            uint32_t parent = nodes[i].parent;
            parents += cursor[parent]++ ? 0 : 1;
            statics += (parent == ROOT || !isSpecialName(nameOf(nodes[i]))) ? 1 : 0;
        }
        uint32_t total = 0;
        uint32_t longest = 0;
        for (uint32_t i = 0; i < nodes.size(); i++) {
            uint32_t count = cursor[i];
            cursor[i] = total;
            total += count;
            longest = std::max(longest, count);
        }
        std::vector<uint32_t> lists(total);
        for (uint32_t i = 1; i < nodes.size(); i++) {
            lists[cursor[nodes[i].parent]++] = i;
        }

        /* Sorts by (priority, kind, name hash); a parameter or a wildcard keeps
         * its place by the order it was added in */
        struct Key {
            uint64_t order;
            uint32_t child;
        };
        std::vector<Key> keys;
        keys.reserve(longest);

        std::vector<uint32_t> sortedEdges;
        sortedEdges.reserve((size_t) parents * CHILD_LIST_HEADER + total + statics);
        uint32_t begin = 0;
        for (uint32_t parent = 0; parent < nodes.size(); parent++) {
            uint32_t end = cursor[parent];
            if (begin == end) {
                nodes[parent].childList = NONE;
                continue;
            }
            uint32_t counts[CHILD_LIST_HEADER] = {0, 0, 0, 0};
            keys.clear();
            for (uint32_t i = begin; i < end; i++) {
                const Node &node = nodes[lists[i]];
                std::string_view name = nameOf(node);
                /* 0 static, 1 parameter, 2 wildcard */
                uint64_t kind = 0;
                if (parent != ROOT && isSpecialName(name)) {
                    kind = name[0] == ':' ? 1 : 2;
                }
                counts[(node.isHighPriority ? 0 : 2) + (kind ? 1 : 0)]++;
                uint64_t order = ((node.isHighPriority ? 0ull : 4ull) | kind) << 32;
                order |= kind ? (uint64_t) lists[i] : (uint64_t) hashName(name);
                keys.push_back({order, lists[i]});
            }
            std::sort(keys.begin(), keys.end(), [](const Key &a, const Key &b) {
                return a.order != b.order ? a.order < b.order : a.child < b.child;
            });

            nodes[parent].childList = (uint32_t) sortedEdges.size();
            sortedEdges.insert(sortedEdges.end(), counts, counts + CHILD_LIST_HEADER);
            const Key *key = keys.data();
            for (uint32_t priority = 0; priority < 2; priority++) {
                uint32_t run = counts[priority * 2];
                for (uint32_t i = 0; i < run; i++) {
                    sortedEdges.push_back((uint32_t) key[i].order);
                }
                for (uint32_t i = 0; i < run + counts[priority * 2 + 1]; i++) {
                    sortedEdges.push_back(key[i].child);
                }
                key += run + counts[priority * 2 + 1];
            }
            begin = end;
        }
        edges = std::move(sortedEdges);
    }

    /* Closes the gaps that removed handlers left. The handlers keep their order,
     * which is the order handlers of one priority run in. */
    void compactHandlers() {
        if (!removedHandlers) {
            return;
        }
        std::vector<uint32_t> renumbered(handlers.size(), NONE);
        uint32_t live = 0;
        for (uint32_t i = 0; i < handlers.size(); i++) {
            if (!handlers[i]) {
                continue;
            }
            renumbered[i] = live;
            if (live != i) {
                handlers[live] = std::move(handlers[i]);
            }
            live++;
        }
        handlers.erase(handlers.begin() + live, handlers.end());
        for (const Node &node : nodes) {
            for (uint32_t link = node.dead ? NONE : node.firstHandler; link != NONE; link = handlerLinks[link].next) {
                uint32_t handler = handlerLinks[link].handler;
                handlerLinks[link].handler = (handler & ~HANDLER_MASK) | renumbered[handler & HANDLER_MASK];
            }
        }
        removedHandlers = 0;
    }

    /* Gives back the capacity that growth left over. shrink_to_fit() does
     * nothing in libstdc++ when exceptions are off. */
    template <typename T>
    static void trim(std::vector<T> &items) {
        if (items.capacity() != items.size()) {
            std::vector<T>(items.begin(), items.end()).swap(items);
        }
    }

    static bool isLaterMethod(std::string_view method, std::string_view other) {
        if (method == "GET" || other == ANY_METHOD_TOKEN) {
            return false;
        }
        return other == "GET" || method == ANY_METHOD_TOKEN || method > other;
    }

    /* Registration is done: sort the child lists and free the index */
    void sortChildren() {
        compactHandlers();
        if (!sorted) {
            compact();
            buildEdges();
            trim(nodes);
            trim(names);
            trim(handlerLinks);
            trim(methodNodes);
            sorted = true;
        }
        std::vector<uint32_t>().swap(lookup);
        lookupCount = 0;

        /* The methods are ordered GET first, ANY last and the rest by name, and
         * route() falls back to the last one. That is ANY unless a removal
         * dropped an ANY node that had no route. */
        getMethod = NONE;
        lastMethod = NONE;
        for (uint32_t method : methodNodes) {
            std::string_view name = nameOf(nodes[method]);
            if (name == "GET") {
                getMethod = method;
            }
            if (lastMethod == NONE || isLaterMethod(name, nameOf(nodes[lastMethod]))) {
                lastMethod = method;
            }
        }
        ready = true;
    }

    void insertHandler(uint32_t node, uint32_t handler) {
        uint32_t link = freeHandlerLink;
        if (link != NONE) {
            freeHandlerLink = handlerLinks[link].next;
            handlerLinks[link].handler = handler;
        } else {
            link = (uint32_t) handlerLinks.size();
            handlerLinks.push_back({handler, NONE});
        }
        /* Insert handler in order sorted by priority (most significant 1 byte) */
        uint32_t *slot = &nodes[node].firstHandler;
        while (*slot != NONE && handlerLinks[*slot].handler <= handler) {
            slot = &handlerLinks[*slot].next;
        }
        handlerLinks[link].next = *slot;
        *slot = link;
    }

    /* Basically a pre-allocated stack */
    struct RouteParameters {
        friend struct HttpRouter;
    private:
        std::string_view params[MAX_URL_SEGMENTS] = {};
        int paramsTop = -1;

        void reset() {
            paramsTop = -1;
        }

        void push(std::string_view param) {
            /* We check these bounds indirectly via the urlSegments limit */
            params[++paramsTop] = param;
        }

        void pop() {
            /* Same here, we cannot pop outside */
            paramsTop--;
        }
    } routeParameters;

    /* Set URL for router. Will reset any URL cache */
    void setUrl(std::string_view url) {

        /* Todo: URL may also start with "http://domain/" or "*", not only "/" */

        /* We expect to stand on a slash */
        currentUrl = url;
        urlSegmentTop = -1;
    }

    /* Lazily parse or read from cache */
    std::pair<std::string_view, bool> getUrlSegment(int urlSegment) {
        if (urlSegment > urlSegmentTop) {
            /* Signal as STOP when we have no more URL or stack space */
            if (!currentUrl.length() || urlSegment > int(MAX_URL_SEGMENTS - 1)) {
                return {{}, true};
            }

            /* We always stand on a slash here, so step over it */
            currentUrl.remove_prefix(1);

            auto segmentLength = currentUrl.find('/');
            if (segmentLength == std::string::npos) {
                segmentLength = currentUrl.length();

                /* Push to url segment vector */
                urlSegmentVector[urlSegment] = currentUrl.substr(0, segmentLength);
                urlSegmentTop++;

                /* Update currentUrl */
                currentUrl = currentUrl.substr(segmentLength);
            } else {
                /* Push to url segment vector */
                urlSegmentVector[urlSegment] = currentUrl.substr(0, segmentLength);
                urlSegmentTop++;

                /* Update currentUrl */
                currentUrl = currentUrl.substr(segmentLength);
            }
        }
        /* In any case we return it */
        return {urlSegmentVector[urlSegment], false};
    }

    /* Executes as many handlers it can */
    bool executeHandlers(uint32_t parent, int urlSegment, UserDataType &userData) {

        auto [segment, isStop] = getUrlSegment(urlSegment);

        /* If we are on STOP, return where we may stand */
        if (isStop) {
            /* We have reached accross the entire URL with no stoppage, execute */
            for (uint32_t link = nodes[parent].firstHandler; link != NONE; link = handlerLinks[link].next) {
                if (handlers[handlerLinks[link].handler & HANDLER_MASK](this)) {
                    return true;
                }
            }
            /* We reached the end, so go back */
            return false;
        }

        uint32_t list = nodes[parent].childList;
        if (list == NONE) {
            return false;
        }

        uint32_t first = list + CHILD_LIST_HEADER;
        for (uint32_t priority = 0; priority < 2; priority++) {
            uint32_t statics = edges[list + priority * 2];
            uint32_t specials = edges[list + priority * 2 + 1];

            /* Static match */
            if (statics) {
                uint32_t match = findStatic(first, statics, segment);
                if (match != NONE && executeHandlers(match, urlSegment + 1, userData)) {
                    return true;
                }
            }

            for (uint32_t i = first + statics * 2; i < first + statics * 2 + specials; i++) {
                uint32_t child = edges[i];
                if (names[nodes[child].nameOffset] == '*') {
                    /* Wildcard match (can be seen as a shortcut) */
                    for (uint32_t link = nodes[child].firstHandler; link != NONE; link = handlerLinks[link].next) {
                        if (handlers[handlerLinks[link].handler & HANDLER_MASK](this)) {
                            return true;
                        }
                    }
                } else if (!segment.empty()) {
                    /* Parameter match */
                    routeParameters.push(segment);
                    if (executeHandlers(child, urlSegment + 1, userData)) {
                        return true;
                    }
                    routeParameters.pop();
                }
            }
            first += statics * 2 + specials;
        }
        return false;
    }

    /* Walks the pattern down from a method node */
    uint32_t findPattern(uint32_t node, std::string_view pattern, bool isHighPriority) {
        setUrl(pattern);
        for (int i = 0; node != NONE && !getUrlSegment(i).second; i++) {
            std::string_view segment = getUrlSegment(i).first;
            if (segment.starts_with(':')) {
                /* Parameter routes are named only : */
                segment = segment.substr(0, 1);
            }
            /* Go to next segment or quit */
            node = findChild(node, segment, isHighPriority);
        }
        return node;
    }

    /* Scans for one matching handler, returning the handler and its priority or UINT32_MAX for not found */
    uint32_t findHandler(std::string_view method, std::string_view pattern, uint32_t priority) {
        uint32_t node = findChild(ROOT, method, false);
        if (node != NONE) {
            node = findPattern(node, pattern, priority == HIGH_PRIORITY);
        }
        if (node == NONE) {
            return UINT32_MAX;
        }
        /* Seek for a priority match in the found node */
        for (uint32_t link = nodes[node].firstHandler; link != NONE; link = handlerLinks[link].next) {
            if ((handlerLinks[link].handler & ~HANDLER_MASK) == priority) {
                return handlerLinks[link].handler;
            }
        }
        return UINT32_MAX;
    }

    bool unlinkHandler(uint32_t node, uint32_t handler) {
        for (uint32_t *slot = &nodes[node].firstHandler; *slot != NONE; slot = &handlerLinks[*slot].next) {
            HandlerLink &link = handlerLinks[*slot];
            if (link.handler == handler) {
                uint32_t removed = *slot;
                *slot = link.next;
                link.next = freeHandlerLink;
                freeHandlerLink = removed;
                return true;
            }
        }
        return false;
    }

public:
    HttpRouter() {
        nodes.push_back({0, 0, NONE, NONE, NONE, 0, false, false});
        /* Always have ANY route */
        uint32_t stored = NONE;
        getNode(ROOT, ANY_METHOD_TOKEN, false, stored);
    }

    std::pair<int, std::string_view *> getParameters() {
        return {routeParameters.paramsTop, routeParameters.params};
    }

    UserDataType &getUserData() {
        return userData;
    }

    /* Call when the routes are registered, so that the first route() does not
     * pay for the sort */
    void sortRoutes() {
        if (!ready) {
            sortChildren();
        }
    }

    /* Fast path */
    bool route(std::string_view method, std::string_view url) {
        if (!ready) [[unlikely]] {
            sortChildren();
        }

        /* Reset url parsing cache */
        setUrl(url);
        routeParameters.reset();

        /* Begin by finding the method node */
        uint32_t last = lastMethod;
        uint32_t node = method == "GET" ? getMethod : sortedFind(ROOT, method, false);
        if (node != NONE && executeHandlers(node, 0, userData)) {
            return true;
        }

        /* Always test any route last */
        if (last == NONE) {
            return false;
        }
        return executeHandlers(last, 0, userData);
    }

    /* Adds the corresponding entires in matching tree and handler list */
    void add(std::span<const std::string_view> methods, std::string_view pattern, MoveOnlyFunction<bool(HttpRouter *)> &&handler, uint32_t priority = MEDIUM_PRIORITY) {
        /* First remove existing handler */
        remove(methods[0], pattern, priority);

        if (handlers.size() >= HANDLER_MASK) {
            compactHandlers();
        }

        /* Where this call stored each segment of the pattern in names */
        uint32_t stored[MAX_URL_SEGMENTS];
        std::fill(stored, stored + MAX_URL_SEGMENTS, NONE);

        for (const std::string_view method : methods) {
            /* Lookup method */
            uint32_t storedMethod = NONE;
            uint32_t node = getNode(ROOT, method, false, storedMethod);
            /* Iterate over all segments */
            setUrl(pattern);
            for (int i = 0; !getUrlSegment(i).second; i++) {
                std::string_view segment = getUrlSegment(i).first;
                if (segment.length() > 1 && segment[0] == ':') {
                    /* Parameter routes must be named only : */
                    segment = segment.substr(0, 1);
                }
                node = getNode(node, segment, priority == HIGH_PRIORITY, stored[i]);
            }
            insertHandler(node, priority | (uint32_t) handlers.size());
        }

        /* Alloate this handler */
        handlers.emplace_back(std::move(handler));
    }

    /* Removes ALL routes with the same handler as can be found with the given parameters.
     * Removing a wildcard is done by removing ONE OF the methods the wildcard would match with.
     * Example: If wildcard includes POST, GET, PUT, you can remove ALL THREE by removing GET. */
    bool remove(std::string_view method, std::string_view pattern, uint32_t priority) {
        uint32_t handler = findHandler(method, pattern, priority);
        if (handler == UINT32_MAX) {
            /* Not found or already removed, do nothing */
            return false;
        }

        /* add() put the handler on the node of this pattern under each of its
         * methods, so no other node can hold it */
        for (size_t i = methodNodes.size(); i-- > 0;) {
            uint32_t node = findPattern(methodNodes[i], pattern, priority == HIGH_PRIORITY);
            if (node != NONE && unlinkHandler(node, handler)) {
                dropIfEmpty(node);
            }
        }

        /* A removal drops every empty node, and an ANY node that nothing was
         * added to is one */
        uint32_t any = findChild(ROOT, ANY_METHOD_TOKEN, false);
        if (any != NONE) {
            dropIfEmpty(any);
        }

        /* Now remove the actual handler */
        handlers[handler & HANDLER_MASK] = nullptr;
        removedHandlers++;
        ready = false;

        return true;
    }
};

}

#endif // UWS_HTTPROUTER_HPP
