import {
    filterByTitleOrUrl,
} from '../content_scripts/common/utils.js';
function request(url, onReady, headers, data, onException) {
    headers = headers || {};
    return new Promise(function(acc, rej) {
        var xhr = new XMLHttpRequest();
        var method = (data !== undefined) ? "POST" : "GET";
        xhr.open(method, url);
        for (var h in headers) {
            xhr.setRequestHeader(h, headers[h]);
        }
        xhr.onload = function() {
            // status from file:/// is always 0
            if (xhr.status === 200 || xhr.status === 0) {
                acc(xhr.responseText);
            } else {
                rej(xhr.status);
            }
        };
        xhr.onerror = rej.bind(null, xhr);
        xhr.send(data);
    }).then(onReady).catch(function(exp) {
        onException && onException(exp);
    });
}

function dictFromArray(arry, val) {
    var dict = {};
    arry.forEach(function(h) {
        dict[h] = val;
    });
    return dict;
}

function extendObject(target, ss) {
    for (var k in ss) {
        target[k] = ss[k];
    }
}

function getSubSettings(set, keys) {
    var subset;
    if (!keys) {
        // if null/undefined/""
        subset = set;
    } else {
        if ( !(keys instanceof Array) ) {
            keys = [ keys ];
        }
        subset = {};
        keys.forEach(function(k) {
            subset[k] = set[k];
        });
    }
    return subset;
}

function _save(storage, data, cb) {
    if (storage === chrome.storage.sync) {
        // don't store snippets from localPath into sync storage, since sync storage has its quota.
        if (data.localPath) {
            delete data.snippets;
        }
        storage.set(data, cb);
    } else {
        if (data.localPath) {
            delete data.snippets;
            // try to fetch snippets from localPath and cache it in local storage.
            request(data.localPath, function(resp) {
                data.snippets = resp;
                storage.set(data, cb);
            });
        } else {
            storage.set(data, cb);
        }
    }
}

var Gist = (function() {
    var self = {};

    function _initGist(token, magic_word, onGistReady) {
        request("https://api.github.com/gists", function(res) {
            var gists = JSON.parse(res);
            var gist = "";
            gists.forEach(function(g) {
                if (g.hasOwnProperty('description') && g['description'] === magic_word && g.files.hasOwnProperty(magic_word)) {
                    gist = g.id;
                }
            });
            if (gist === "") {
                request("https://api.github.com/gists", function(res) {
                    var ng = JSON.parse(res);
                    onGistReady(ng.id);
                }, {
                    'Authorization': 'token ' + token
                }, `{ "description": "${magic_word}", "public": false, "files": { "${magic_word}": { "content": "${magic_word}" } } }`);
            } else {
                onGistReady(gist);
            }
        }, {
            'Authorization': 'token ' + token
        });
    }

    var _token, _gist = "", _comments = [];
    self.initGist = function(token, onGistReady) {
        if (_token === token && _gist !== "") {
            return _gist;
        } else {
            _token = token;
            _initGist(_token, "cloudboard", function(gist) {
                _gist = gist;
                onGistReady && onGistReady(_gist);
            });
        }
    };

    function _newComment(text, cb) {
        request(`https://api.github.com/gists/${_gist}/comments`, function(res) {
            cb && cb(res);
        }, {
            'Authorization': 'token ' + _token
        }, `{"body": "${encodeURIComponent(text)}"}`);
    }
    function _readComment(cid, cb) {
        request(`https://api.github.com/gists/${_gist}/comments/${cid}`, function(res) {
            var comment = JSON.parse(res);
            cb({status: 0, content: decodeURIComponent(comment.body)});
        }, {
            'Authorization': 'token ' + _token
        });
    }
    function _listComment(cb) {
        request(`https://api.github.com/gists/${_gist}/comments`, function(res) {
            _comments = JSON.parse(res).map(function(c) {
                return c.id;
            });
            cb(_comments);
        }, {
            'Authorization': 'token ' + _token
        });
    }
    function _writeComment(cid, clip, cb) {
        request(`https://api.github.com/gists/${_gist}/comments/${cid}`, function(res) {
            cb && cb(res);
        }, {
            'Authorization': 'token ' + _token
        }, `{"body": "${encodeURIComponent(clip)}"}`);
    }
    self.readComment = function(nr, cb) {
        if (_gist === "") {
            cb({status: 1, content: "Please call initGist first!"});
        } else if (nr >= _comments.length) {
            _listComment(function(cmts) {
                if (nr < cmts.length) {
                    _readComment(cmts[nr], cb);
                } else {
                    cb({status: 1, content: "Register not exists!"});
                }
            });
        } else {
            _readComment(_comments[nr], cb);
        }
    };
    self.editComment = function(nr, clip, cb) {
        if (_gist === "") {
            cb({status: 1, content: "Please call initGist first!"});
        } else if (nr >= _comments.length) {
            _listComment(function(cmts) {
                if (nr < cmts.length) {
                    _writeComment(cmts[nr], clip, cb);
                } else {
                    var toCreate = nr - cmts.length + 1;
                    function cbAfterCreated() {
                        toCreate --;
                        if (toCreate > 0) {
                            _newComment(".", cbAfterCreated);
                        } else if (toCreate === 0) {
                            _newComment(clip, cb);
                        }
                    }
                    cbAfterCreated();
                }
            });
        } else {
            _writeComment(_comments[nr], clip, cb);
        }
    };

    return self;
})();

function start(browser) {
    var self = {};

    var tabHistory = [],
        tabHistoryIndex = 0,
        chromelikeNewTabPosition = 0,
        historyTabAction = false;

    // data by tab id
    var tabActivated = {},
        tabMessages = {},
        tabURLs = {};

    var newTabUrl = browser._setNewTabUrl();

    var conf = {
        focusAfterClosed: "right",
        repeatThreshold: 99,
        tabsMRUOrder: true,
        newTabPosition: 'default',
        showTabIndices: false,
        interceptedErrors: []
    };

    var bookmarkFolders = [];
    function getFolders(tree, root) {
        var cd = root;
        if (tree.title !== "" && (!tree.hasOwnProperty('url') || tree.url === undefined)) {
            cd += "/" + tree.title;
            bookmarkFolders.push({id: tree.id, title: cd + "/"});
        }
        if (tree.hasOwnProperty('children')) {
            for (var i = 0; i < tree.children.length; ++i) {
                getFolders(tree.children[i], cd);
            }
        }
    }

    function createBookmark(page, onCreated) {
        if (page.path.length) {
            chrome.bookmarks.create({
                'parentId': page.folder,
                'title': page.path.shift()
            }, function(newFolder) {
                page.folder = newFolder.id;
                createBookmark(page, onCreated);
            });
        } else {
            chrome.bookmarks.create({
                'parentId': page.folder,
                'title': page.title,
                'url': page.url
            }, function(ret) {
                onCreated(ret);
            });
        }
    }

    function loadSettings(keys, cb) {
        var tmpSet = {
            blocklist: {},
            marks: {},
            findHistory: [],
            cmdHistory: [],
            sessions: {},
            proxyMode: 'clear',
            autoproxy_hosts: [],
            proxy: []
        };

        browser.loadRawSettings(keys, function(set) {
            if (typeof(set.proxy) === "string") {
                set.proxy = [set.proxy];
                set.autoproxy_hosts = [set.autoproxy_hosts];
            }
            if (set.localPath) {
                request(set.localPath, function(resp) {
                    set.snippets = resp;
                    cb(set);
                }, undefined, undefined, function (po) {
                    // failed to read snippets from localPath
                    set.error = "Failed to read snippets from " + set.localPath;
                    cb(set);
                });
            } else {
                cb(set);
            }
        }, tmpSet);
    }

    loadSettings(null, browser._applyProxySettings);

    function removeTab(tabId) {
        delete tabActivated[tabId];
        delete tabMessages[tabId];
        delete tabURLs[tabId];
        tabHistory = tabHistory.filter(function(e) {
            return e !== tabId;
        });
        if (_queueURLs.length) {
            chrome.tabs.create({
                active: false,
                url: _queueURLs.shift()
            });
        }

        _updateTabIndices();
    }
    chrome.tabs.onRemoved.addListener(removeTab);
    function _setScrollPos_bg(tabId) {
        if (tabMessages.hasOwnProperty(tabId)) {
            var message = tabMessages[tabId];
            chrome.tabs.executeScript(tabId, {
                code: "_setScrollPos(" + message.scrollLeft + ", " + message.scrollTop + ")"
            });
            delete tabMessages[tabId];
        }
    }

    function sendTabMessage(tabId, frameId, message, cb) {
        if (frameId === -1) {
            chrome.tabs.sendMessage(tabId, message);
        } else {
            chrome.tabs.sendMessage(tabId, message, {frameId: frameId});
        }
    }
    var _lastActiveTabId = null;
    function _tabActivated(tabId) {
        if (_lastActiveTabId !== tabId) {
            if (_lastActiveTabId !== null) {
                sendTabMessage(_lastActiveTabId, 0, {
                    subject: 'tabDeactivated'
                });
            }
            sendTabMessage(tabId, 0, {
                subject: 'tabActivated'
            });
            _lastActiveTabId = tabId;
        }
    }
    chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
        if (changeInfo.status === "complete") {
            if (tab.active) {
                _tabActivated(tabId);
            }
        }
        if (browser.detectTabTitleChange && changeInfo.title) {
            sendTabMessage(tabId, 0, {
                subject: 'titleChanged',
                changeInfo
            });
        }
        _setScrollPos_bg(tabId);
    });
    chrome.windows.onFocusChanged.addListener(function(w) {
        getActiveTab(function(tab) {
            _tabActivated(tab.id);
        });
    });

    chrome.tabs.onCreated.addListener(function(tab) {
        _setScrollPos_bg(tab.id);

        _updateTabIndices();
    });
    chrome.tabs.onMoved.addListener(function() {
        _updateTabIndices();
    });
    chrome.tabs.onActivated.addListener(function(activeInfo) {
        if (!historyTabAction && activeInfo.tabId != tabHistory[tabHistory.length - 1]) {
            if (tabHistory.length > 10) {
                tabHistory.shift();
            }
            if (tabHistoryIndex != tabHistory.length - 1) {
                tabHistory.splice(tabHistoryIndex + 1, tabHistory.length - 1);
            }
            tabHistory.push(activeInfo.tabId);
            tabHistoryIndex = tabHistory.length - 1;
        }
        tabActivated[activeInfo.tabId] = new Date().getTime();
        _tabActivated(activeInfo.tabId);
        historyTabAction = false;
        chromelikeNewTabPosition = 0;

        _setScrollPos_bg(activeInfo.tabId);
        _updateTabIndices();
    });
    chrome.tabs.onDetached.addListener(function() {
        _updateTabIndices();
    });
    chrome.tabs.onAttached.addListener(function() {
        _updateTabIndices();
    });

    function getActiveTab(cb) {
        chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
            tabs.length > 0 && cb(tabs[0]);
        });
    }
    chrome.commands.onCommand.addListener(function(command) {
        switch (command) {
            case 'restartext':
                chrome.tabs.query({}, function(tabs) {
                    tabs.forEach(function(tab) {
                        chrome.tabs.reload(tab.id);
                    });
                    chrome.runtime.reload();
                });
                break;
            case 'previousTab':
            case 'nextTab':
                getActiveTab(function(tab) {
                    var index = (command === 'previousTab') ? tab.index - 1 : tab.index + 1;
                    chrome.tabs.query({ windowId: tab.windowId }, function(tabs) {
                        index = ((index % tabs.length) + tabs.length) % tabs.length;
                        chrome.tabs.update(tabs[index].id, { active: true });
                    });
                });
                break;
            case 'closeTab':
                getActiveTab(function(tab) {
                    chrome.tabs.remove(tab.id);
                });
                break;
            case 'proxyThis':
                getActiveTab(function(tab) {
                    var host = new URL(tab.url || tab.pendingUrl).host;
                    updateProxy({
                        host: host,
                        operation: "toggle"
                    }, function() {
                        chrome.tabs.reload(tab.id, {
                            bypassCache: true
                        });
                    });
                });
                break;
            default:
                break;
        }
    });

    self.pendingPorts = [];
    function _response(message, sendResponse, result) {
        var idx = self.pendingPorts.indexOf(message);
        if (idx !== -1) {
            self.pendingPorts.splice(idx, 1);
        }
        sendResponse(result);
    }
    chrome.runtime.onMessage.addListener(function (_message, _sender, _sendResponse) {
        if (self.hasOwnProperty(_message.action)) {
            if (_message.repeats > conf.repeatThreshold) {
                _message.repeats = conf.repeatThreshold;
            }
            var result = self[_message.action](_message, _sender, _sendResponse);
            if (_message.needResponse) {
                if (result) {
                    _sendResponse(result);
                    _message.needResponse = false;
                } else {
                    self.pendingPorts.push(_message);
                    // An asynchronous response will be sent using sendResponse later.
                }
                return _message.needResponse;
            }
        } else {
            console.log("[unexpected runtime message] " + JSON.stringify(_message));
        }
    });

    function _updateSettings(diffSettings, afterSet) {
        diffSettings.savedAt = new Date().getTime();
        _save(chrome.storage.local, diffSettings, function() {
            if (afterSet) {
                afterSet();
            }
        });
        _save(chrome.storage.sync, diffSettings, function() {
            if (chrome.runtime.lastError) {
                var error = chrome.runtime.lastError.message;
            }
        });
    }

    function _broadcastSettings(data) {
        chrome.tabs.query({}, function(tabs) {
            tabs.forEach(function(tab) {
                sendTabMessage(tab.id, -1, {
                    subject: 'settingsUpdated',
                    settings: data
                });
            });
        });
    }

    function _updateAndPostSettings(diffSettings, afterSet) {
        _broadcastSettings(diffSettings);
        _updateSettings(diffSettings, afterSet);
    }

    function _updateTabIndices() {
        if (conf.showTabIndices) {
            chrome.tabs.query({currentWindow: true}, function(tabs) {
                tabs.forEach(function(tab) {
                    sendTabMessage(tab.id, 0, {
                        subject: "tabIndexChange",
                        index: tab.index + 1
                    });
                });
            });
        }
    }

    function getSenderUrl(sender) {
        // use the tab's url if sender is a frame with blank url.
        return (sender.frameId !== 0 && sender.url === "about:blank") ? sender.tab.url : sender.url;
    }
    function _getState(set, url, blocklistPattern, lurkingPattern) {
        if (set.blocklist['.*']) {
            return "disabled";
        }
        if (url) {
            if (set.blocklist[url.origin]) {
                return "disabled";
            }
            if (blocklistPattern) {
                blocklistPattern = new RegExp(blocklistPattern.source, blocklistPattern.flags);
                if (blocklistPattern.test(url.href)) {
                    return "disabled";
                }
            }
            if (lurkingPattern) {
                lurkingPattern = new RegExp(lurkingPattern.source, lurkingPattern.flags);
                if (lurkingPattern.test(url.href)) {
                    return "lurking";
                }
            }
        }
        return "enabled";
    }
    self.toggleBlocklist = function(message, sender, sendResponse) {
        loadSettings('blocklist', function(data) {
            var origin = ".*";
            var senderOrigin = sender.origin || new URL(getSenderUrl(sender)).origin;
            if (chrome.extension.getURL("/").indexOf(senderOrigin) !== 0 && senderOrigin !== "null") {
                origin = senderOrigin;
            }
            if (data.blocklist.hasOwnProperty(origin)) {
                delete data.blocklist[origin];
            } else {
                data.blocklist[origin] = 1;
            }
            _updateAndPostSettings({blocklist: data.blocklist}, function() {
                sendResponse({
                    state: _getState(data, sender.tab ? new URL(getSenderUrl(sender)) : null, message.blocklistPattern, message.lurkingPattern),
                    blocklist: data.blocklist,
                    url: origin
                });
            });
        });
    };
    self.toggleMouseQuery = function(message, sender, sendResponse) {
        loadSettings('mouseSelectToQuery', function(data) {
            if (sender.tab && sender.tab.url.indexOf(chrome.extension.getURL("/")) !== 0) {
                var mouseSelectToQuery = data.mouseSelectToQuery || [];
                var idx = mouseSelectToQuery.indexOf(message.origin);
                if (idx === -1) {
                    mouseSelectToQuery.push(message.origin);
                } else {
                    mouseSelectToQuery.splice(idx, 1);
                }
                _updateAndPostSettings({mouseSelectToQuery: mouseSelectToQuery});
            }
        });
    };
    self.getState = function(message, sender, sendResponse) {
        loadSettings(['blocklist', 'noPdfViewer'], function(data) {
            if (sender.tab) {
                _response(message, sendResponse, {
                    noPdfViewer: data.noPdfViewer,
                    state: _getState(data, new URL(getSenderUrl(sender)), message.blocklistPattern, message.lurkingPattern)
                });
            }
        });
    };

    self.addVIMark = function(message, sender, sendResponse) {
        loadSettings('marks', function(data) {
            extendObject(data.marks, message.mark);
            _updateAndPostSettings({marks: data.marks});
        });
    };
    self.jumpVIMark = function(message, sender, sendResponse) {
        loadSettings("marks", function(data) {
            var marks = data.marks;
            if (marks.hasOwnProperty(message.mark)) {
                var markInfo = marks[message.mark];
                chrome.tabs.query({}, function(tabs) {
                    tabs = tabs.filter(function(t) {
                        return t.url === markInfo.url;
                    });

                    if (tabs.length === 0) {
                        markInfo.tab = {
                            tabbed: true,
                            active: true
                        };
                        self.openLink(markInfo, sender, sendResponse);
                    } else {
                        if (markInfo.scrollLeft || markInfo.scrollTop) {
                            tabMessages[tabs[0].id] = {
                                scrollLeft: markInfo.scrollLeft,
                                scrollTop: markInfo.scrollTop
                            };
                        }
                        if (tabs[0].id === sender.tab.id) {
                            _setScrollPos_bg(tabs[0].id);
                        } else {
                            chrome.tabs.update(tabs[0].id, {
                                active: true
                            });
                        }
                    }
                });
            }
        });
    };

    function _loadSettingsFromUrl(url, cb) {
        request(url, function(resp) {
            _updateAndPostSettings({localPath: url, snippets: resp});
            cb({status: "Succeeded", snippets: resp});
        }, undefined, undefined, function (po) {
            cb({status: "Failed"});
        });
    };

    self.resetSettings = function(message, sender, sendResponse) {
        chrome.storage.local.clear();
        chrome.storage.sync.clear();
        loadSettings(null, function(data) {
            browser._applyProxySettings(data);
            _response(message, sendResponse, {
                settings: data
            });
            _broadcastSettings(data);
        });
    };
    self.loadSettingsFromUrl = function(message, sender, sendResponse) {
        _loadSettingsFromUrl(message.url, function(status) {
            _response(message, sendResponse, status);
        });
    };
    function _filterByTitleOrUrl(tabs, query) {
        tabs = tabs.filter(function(b) {
            return b.url;
        });
        return filterByTitleOrUrl(tabs, query);
    }
    self.getRecentlyClosed = function(message, sender, sendResponse) {
        chrome.sessions.getRecentlyClosed({}, function(sessions) {
            var tabs = [];
            for (var i = 0; i < sessions.length; i ++) {
                var s = sessions[i];
                if (s.hasOwnProperty('window')) {
                    tabs = tabs.concat(s.window.tabs);
                } else if (s.hasOwnProperty('tab')) {
                    tabs.push(s.tab);
                }
            }
            tabs = _filterByTitleOrUrl(tabs, message.query);
            _response(message, sendResponse, {
                urls: tabs
            });
        });
    };
    self.getTopSites = function(message, sender, sendResponse) {
        if (chrome.topSites) {
            chrome.topSites.get(function(urls) {
                urls = _filterByTitleOrUrl(urls, message.query);
                _response(message, sendResponse, {
                    urls: urls
                });
            });
        } else {
            _response(message, sendResponse, {
                urls: []
            });
        }
    };


    function _getHistory(text, maxResults, cb, sortByMostUsed) {
        browser.getLatestHistoryItem(text, maxResults, (items) => {
            if (sortByMostUsed) {
                items = items.sort(function(a, b) {
                    return b.visitCount - a.visitCount;
                });
            }
            cb(items);
        });
    }
    self.getAllURLs = function(message, sender, sendResponse) {
        chrome.bookmarks.search(message.query || {}, function(bmItems) {
            var urls = bmItems,
                requestCount = message.maxResults || 100;
            var maxResults = requestCount - urls.length;
            if (maxResults > 0) {
                _getHistory(message.query || "", maxResults,  function(historyItems) {
                    urls = urls.concat(historyItems);
                    _response(message, sendResponse, {
                        urls: urls
                    });
                }, true);
            } else {
                _response(message, sendResponse, {
                    urls: urls.slice(0, requestCount)
                });
            }
        });
    };
    self.getTabs = function(message, sender, sendResponse) {
        var tab = sender.tab;
        var queryInfo = message.queryInfo || {};
        chrome.tabs.query(queryInfo, function(tabs) {
            tabs = _filterByTitleOrUrl(tabs, message.query);
            if (message.query && message.query.length) {
                tabs = tabs.filter(function(b) {
                    return b.title.indexOf(message.query) !== -1 || (b.url && b.url.indexOf(message.query) !== -1);
                });
            }
            if (tabs.length > message.tabsThreshold && conf.tabsMRUOrder) {
                tabs.sort(function(x, y) {
                    // Shift tabs without "last access" data to the end
                    var a = tabActivated[x.id];
                    var b = tabActivated[y.id];

                    if (!isFinite(a) && !isFinite(b)) {
                        return 0;
                    }

                    if (!isFinite(a)) {
                        return 1;
                    }

                    if (!isFinite(b)) {
                        return -1;
                    }

                    return b - a;
                });
            }
            _response(message, sendResponse, {
                tabs: tabs
            });
        });
    };
    self.togglePinTab = function(message, sender, sendResponse) {
        getActiveTab(function(tab) {
            return chrome.tabs.update(tab.id, {
                pinned: !tab.pinned
            });
        });
    };
    function focusTab(windowId, tabId) {
        chrome.windows.update(windowId, {
            focused: true
        }, function() {
            chrome.tabs.update(tabId, {
                active: true
            });
        });
    }
    self.focusTab = function(message, sender, sendResponse) {
        if (message.windowId !== undefined && sender.tab.windowId !== message.windowId) {
            focusTab(message.windowId, message.tabId);
        } else {
            chrome.tabs.update(message.tabId, {
                active: true
            });
        }
    };
    self.focusTabByIndex = function(message, sender, sendResponse) {
        var queryInfo = message.queryInfo || {};
        chrome.tabs.query(queryInfo, function(tabs) {
            if (message.repeats > 0 && message.repeats <= tabs.length) {
                chrome.tabs.update(tabs[message.repeats - 1].id, {
                    active: true
                });
            }
        });
    };
    self.goToLastTab = function(message, sender, sendResponse) {
        if (tabHistory.length > 1) {
            var lastTab = tabHistory[tabHistory.length - 2];
            chrome.tabs.update(lastTab, {
                active: true
            });
        }
    };
    self.historyTab = function(message, sender, sendResponse) {
        if (tabHistory.length > 0) {
            historyTabAction = true;
            if (message.hasOwnProperty("index")) {
                tabHistoryIndex = (parseInt(message.index) + tabHistory.length) % tabHistory.length;
            } else {
                tabHistoryIndex += message.backward ? -1 : 1;
                if (tabHistoryIndex < 0) {
                    tabHistoryIndex = 0;
                } else if (tabHistoryIndex >= tabHistory.length) {
                    tabHistoryIndex = tabHistory.length - 1;
                }
            }
            const tabId = tabHistory[tabHistoryIndex];
            chrome.tabs.update(tabId, {
                active: true
            });
        }
    };
    // limit to between 0 and length
    function _fixTo(to, length) {
        if (to < 0) {
            to = 0;
        } else if (to >= length){
            to = length;
        }
        return to;
    }
    // round base ahead if repeats reaches length
    function _roundBase(base, repeats, length) {
        if (repeats > length - base) {
            base -= repeats - (length - base);
        }
        return base;
    }
    function _nextTab(tab, step) {
        if (tab) {
            chrome.tabs.query({
                windowId: tab.windowId
            }, function(tabs) {
                if (tab.index == 0 && step == -1) {
                    step = tabs.length -1 ;
                } else if (tab.index == tabs.length -1 && step == 1 ) {
                    step = 1 - tabs.length ;
                }
                var to = _fixTo(tab.index + step, tabs.length - 1);
                chrome.tabs.update(tabs[to].id, {
                    active: true
                });
            });
        } else {
            getActiveTab(function(t) {
                _nextTab(t, step);
            });
        }
    }
    self.nextTab = function(message, sender, sendResponse) {
        _nextTab(sender.tab, message.repeats);
    };
    self.previousTab = function(message, sender, sendResponse) {
        _nextTab(sender.tab, -message.repeats);
    };
    function _roundRepeatTabs(tab, repeats, operation) {
        if (tab) {
            chrome.tabs.query({
                windowId: tab.windowId
            }, function(tabs) {
                var tabIds = tabs.map(function(e) {
                    return e.id;
                });
                repeats = _fixTo(repeats, tabs.length);
                var base = _roundBase(tab.index, repeats, tabs.length);
                operation(tabIds.slice(base, base + repeats));
            });
        } else {
            getActiveTab(function(t) {
                _roundRepeatTabs(t, repeats, operation);
            });
        }
    }
    self.reloadTab = function(message, sender, sendResponse) {
        _roundRepeatTabs(sender.tab, message.repeats, function(tabIds) {
            tabIds.forEach(function(tabId) {
                chrome.tabs.reload(tabId, {
                    bypassCache: message.nocache
                });
            });
        });
    };
    self.closeTab = function(message, sender, sendResponse) {
        _roundRepeatTabs(sender.tab, message.repeats, function(tabIds) {
            chrome.tabs.remove(tabIds, function() {
                if ( conf.focusAfterClosed === "left" ) {
                    _nextTab(sender.tab, -1);
                } else if ( conf.focusAfterClosed === "last" ) {
                    self.historyTab({backward: true});
                }
            });
        });
    };

    function _closeTab(s, n) {
        chrome.tabs.query({currentWindow: true}, function(tabs) {
            tabs = tabs.map(function(e) { return e.id; });
            chrome.tabs.remove(tabs.slice(s.tab.index + (n < 0 ? n : 1),
                                          s.tab.index + (n < 0 ? 0 : 1 + n)));
        });
    };

    self.closeTabLeft  = function(message, sender, senderResponse) { _closeTab(sender, -message.repeats);};
    self.closeTabRight = function(message, sender, senderResponse) { _closeTab(sender, message.repeats); };
    self.closeTabsToLeft = function(message, sender, senderResponse) { _closeTab(sender, -sender.tab.index); };
    self.closeTabsToRight = function(message, sender, senderResponse) {
        chrome.tabs.query({currentWindow: true},
                          function(tabs) { _closeTab(sender, tabs.length - sender.tab.index); });
    };
    self.tabOnly = function(message, sender, sendResponse) {
        chrome.tabs.query({currentWindow: true}, function(tabs) {
            tabs = tabs.filter(function(t) {
                return t.id != sender.tab.id && !t.pinned;
            }).map(function(t) { return t.id });
            chrome.tabs.remove(tabs);
        });
    };

    self.closeAudibleTab = function(message, sender, sendResponse) {
        chrome.tabs.query({audible: true}, function(tabs) {
            if (tabs) {
                chrome.tabs.remove(tabs[0].id)
            }
        });
    };
    self.muteTab = function(message, sender, sendResponse) {
        var tab = sender.tab;
        chrome.tabs.update(tab.id, {
            muted: ! tab.mutedInfo.muted
        });
    };
    self.openLast = function(message, sender, sendResponse) {
        chrome.sessions.restore();
    };
    self.duplicateTab = function(message, sender, sendResponse) {
        chrome.tabs.duplicate(sender.tab.id, function() {
            if (message.active === false) {
                chrome.tabs.update(sender.tab.id, { active: true });
            }
        });
    };
    let previousWindowChoice = -1;
    self.getWindows = function (message, sender, sendResponse) {
        chrome.tabs.query({currentWindow: false}, function(tabs) {
            const windows = {};
            tabs.forEach(t => {
                const tabsInWindow = windows[t.windowId] || [];
                tabsInWindow.push({title: t.title, url: t.url});
                windows[t.windowId] = tabsInWindow;
            });
            _response(message, sendResponse, {
                windows: Object.keys(windows).map(w => {
                    return {
                        id: w,
                        tabs: windows[w],
                        isPreviousChoice: (parseInt(w) === previousWindowChoice)
                    };
                })
            });
        });
    };
    self.moveToWindow = function(message, sender, sendResponse) {
        if (message.windowId === -1) {
            chrome.windows.create({tabId: sender.tab.id});
        } else {
            chrome.tabs.move(sender.tab.id, {windowId: message.windowId, index: -1}, () => {
                focusTab(message.windowId, sender.tab.id);
            });
        }
        previousWindowChoice = message.windowId;
    };
    self.gatherWindows = function(message, sender, sendResponse) {
        const windowId = sender.tab.windowId;
        chrome.tabs.query({currentWindow: false}, function(tabs) {
            tabs.forEach(function(tab) {
                chrome.tabs.move(tab.id, {windowId, index: -1});
            });
        });
    };
    self.gatherTabs = function(message, sender, sendResponse) {
        const windowId = sender.tab.windowId;
        message.tabs.forEach(function(tab) {
            chrome.tabs.move(tab.id, {windowId, index: -1});
        });
    };
    self.getBookmarkFolders = function(message, sender, sendResponse) {
        chrome.bookmarks.getTree(function(tree) {
            bookmarkFolders = [];
            getFolders(tree[0], "");
            _response(message, sendResponse, {
                folders: bookmarkFolders
            });
        });
    };
    self.createBookmark = function(message, sender, sendResponse) {
        removeBookmark(message.page.url, function() {
            createBookmark(message.page, function(ret) {
                _response(message, sendResponse, {
                    bookmark: ret
                });
            });
        });
    };
    function filterBookmarksByQuery(bookmarks, query, caseSensitive) {
        return bookmarks.filter(function(b) {
            var title = b.title, url = b.url;
            if (!caseSensitive) {
                title = title.toLowerCase();
                url = url && url.toLowerCase();
                query = query.toLowerCase();
            }
            return title.indexOf(query) !== -1 || (url && url.indexOf(query) !== -1);
        });
    }
    self.getBookmarks = function(message, sender, sendResponse) {
        if (message.parentId) {
            chrome.bookmarks.getSubTree(message.parentId, function(tree) {
                var bookmarks = tree[0].children;
                if (message.query && message.query.length) {
                    bookmarks = filterBookmarksByQuery(bookmarks, message.query, message.caseSensitive);
                }
                _response(message, sendResponse, {
                    bookmarks: bookmarks
                });
            });
        } else {
            if (message.query && message.query.length) {
                chrome.bookmarks.search(message.query, function(tree) {
                    _response(message, sendResponse, {
                        bookmarks: filterBookmarksByQuery(tree, message.query, message.caseSensitive)
                    });
                });
            } else {
                chrome.bookmarks.getTree(function(tree) {
                    _response(message, sendResponse, {
                        bookmarks: tree[0].children
                    });
                });
            }
        }
    };
    self.getHistory = function(message, sender, sendResponse) {
        _getHistory(message.query || "", message.maxResults || 100, function(tree) {
            _response(message, sendResponse, {
                history: tree
            });
        }, message.sortByMostUsed);
    };
    self.addHistories = function(message, sender, sendResponse) {
        message.history.forEach(h => {
            chrome.history.addUrl({url: h});
        });
    };
    function normalizeURL(url) {
        if (!/^view-source:|^javascript:/.test(url) && /^(?:https?:\/\/)?(?:[^@\/\n]+@)?(?:www\.)?([^:\/\n]+)/im.test(url)) {
            if (/^[\w-]+?:/i.test(url)) {
                url = url;
            } else {
                url = "http://" + url;
            }
        }
        return url;
    }

    function openUrlInNewTab(currentTab, url, message) {
        var newTabPosition;
        if (currentTab) {
            switch (conf.newTabPosition) {
                case 'left':
                    newTabPosition = currentTab.index;
                    break;
                case 'right':
                    newTabPosition = currentTab.index + 1;
                    break;
                case 'first':
                    newTabPosition = 0;
                    break;
                case 'last':
                    break;
                default:
                    newTabPosition = currentTab.index + 1 + chromelikeNewTabPosition;
                    chromelikeNewTabPosition++;
                    break;
            }
        }
        chrome.tabs.create({
            url: url,
            active: message.tab.active,
            index: newTabPosition,
            pinned: message.tab.pinned,
            openerTabId: currentTab.id
        }, function(tab) {
            if (message.scrollLeft || message.scrollTop) {
                tabMessages[tab.id] = {
                    scrollLeft: message.scrollLeft,
                    scrollTop: message.scrollTop
                };
            }
        });
    }

    self.openLink = function(message, sender, sendResponse) {
        var url = normalizeURL(message.url);
        if (url.startsWith("javascript:")) {
            chrome.tabs.executeScript(sender.tab.id, {
                code: url.substr(11)
            });
        } else {
            if (message.tab.tabbed) {
                if (sender.frameId !== 0 && chrome.extension.getURL("pages/frontend.html") === sender.url
                    || !sender.tab) {
                    // if current call was made from Omnibar, the sender.tab may be stale,
                    // as sender was bound when port was created.
                    getActiveTab(function(tab) {
                        openUrlInNewTab(tab, url, message);
                    });
                } else {
                    openUrlInNewTab(sender.tab, url, message);
                }
            } else {
                chrome.tabs.update({
                    url: url,
                    pinned: message.tab.pinned || sender.tab.pinned
                }, function(tab) {
                    if (message.scrollLeft || message.scrollTop) {
                        tabMessages[tab.id] = {
                            scrollLeft: message.scrollLeft,
                            scrollTop: message.scrollTop
                        };
                    }
                });
            }
        }
    };
    self.viewSource = function(message, sender, sendResponse) {
        message.url = 'view-source:' + sender.tab.url;
        self.openLink(message, sender, sendResponse);
    };
    self.getSettings = function(message, sender, sendResponse) {
        var pf = loadSettings;
        if (message.key === "RAW") {
            pf = browser.loadRawSettings;
            message.key = "";
        }
        pf(message.key, function(data) {
            _response(message, sendResponse, {
                settings: data
            });
        });
    };
    self.updateSettings = function(message, sender, sendResponse) {
        if (message.scope === "snippets") {
            // For settings from snippets, don't broadcast the update
            // neither persist into storage
            for (var k in message.settings) {
                if (conf.hasOwnProperty(k)) {
                    conf[k] = message.settings[k];
                }
            }
        } else {
            _updateAndPostSettings(message.settings);
        }
    };
    self.setSurfingkeysIcon = function(message, sender, sendResponse) {
        let icon = "icons/48.png";
        if (message.status === "disabled") {
            icon = "icons/48-x.png";
        } else if (message.status === "lurking") {
            icon = "icons/48-l.png";
        }
        chrome.browserAction.setIcon({
            path: icon,
            tabId: (sender.tab ? sender.tab.id : undefined)
        });
    };
    self.request = function(message, sender, sendResponse) {
        request(message.url, function(res) {
            _response(message, sendResponse, {
                text: res
            });
        }, message.headers, message.data);
    };
    self.requestImage = function(message, sender, sendResponse) {
        const img = document.createElement("img");
        img.crossOrigin = "Anonymous";
        img.src = message.url;
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.height = img.naturalHeight;
            canvas.width = img.naturalWidth;
            const ctx = canvas.getContext('2d');

            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            _response(message, sendResponse, {
                text: canvas.toDataURL()
            });
        };

    };
    self.nextFrame = function(message, sender, sendResponse) {
        var tid = sender.tab.id;
        chrome.tabs.executeScript(tid, {
            allFrames: true,
            matchAboutBlank: true,
            runAt: "document_start",
            code: "typeof(getFrameId) === 'function' && getFrameId()"
        }, function(framesInTab) {
            framesInTab = framesInTab.filter(function(frameId) {
                return frameId;
            });

            if (framesInTab.length > 0) {
                let i = 0;
                for (i = 0; i < framesInTab.length; i++) {
                    if (framesInTab[i] === message.frameId) {
                        break;
                    }
                }
                i = (i === framesInTab.length - 1) ? 0 : i + 1;
                sendTabMessage(tid, -1, {
                    subject: "focusFrame",
                    frameId: framesInTab[i]
                });
            }
        });
    };
    self.moveTab = function(message, sender, sendResponse) {
        chrome.tabs.query({
            windowId: sender.tab.windowId
        }, function(tabs) {
            var to = _fixTo(sender.tab.index + message.step * message.repeats, tabs.length);
            chrome.tabs.move(sender.tab.id, {
                index: to
            });
        });
    };
    function _quit() {
        chrome.windows.getAll({
            populate: false
        }, function(windows) {
            windows.forEach(function(w) {
                chrome.windows.remove(w.id);
            });
        });
    }
    self.quit = function(message, sender, sendResponse) {
        _quit();
    };
    self.createSession = function(message, sender, sendResponse) {
        loadSettings('sessions', function(data) {
            chrome.tabs.query({}, function(tabs) {
                var tabGroup = {};
                tabs.forEach(function(tab) {
                    if (tab && tab.index !== void 0) {
                        if (!tabGroup.hasOwnProperty(tab.windowId)) {
                            tabGroup[tab.windowId] = [];
                        }
                        if (tab.url !== newTabUrl) {
                            tabGroup[tab.windowId].push(tab.url);
                        }
                    }
                });
                var tabg = [];
                for (var k in tabGroup) {
                    if (tabGroup[k].length) {
                        tabg.push(tabGroup[k]);
                    }
                }
                data.sessions[message.name] = {};
                data.sessions[message.name]['tabs'] = tabg;
                _updateAndPostSettings({
                    sessions: data.sessions
                }, (message.quitAfterSaved ? _quit : undefined));
            });
        });
    };
    self.openSession = function(message, sender, sendResponse) {
        loadSettings('sessions', function(data) {
            if (data.sessions.hasOwnProperty(message.name)) {
                var urls = data.sessions[message.name]['tabs'];
                urls[0].forEach(function(url) {
                    chrome.tabs.create({
                        url: url,
                        active: false,
                        pinned: false
                    });
                });
                for (var i = 1; i < urls.length; i++) {
                    var a = urls[i];
                    chrome.windows.create({}, function(win) {
                        a.forEach(function(url) {
                            chrome.tabs.create({
                                windowId: win.id,
                                url: url,
                                active: false,
                                pinned: false
                            });
                        });
                    });
                }
                chrome.tabs.query({
                    url: newTabUrl
                }, function(tabs) {
                    chrome.tabs.remove(tabs.map(function(t) {
                        return t.id;
                    }));
                });
            }
        });
    };
    self.deleteSession = function(message, sender, sendResponse) {
        loadSettings('sessions', function(data) {
            delete data.sessions[message.name];
            _updateAndPostSettings({
                sessions: data.sessions
            });
        });
    };
    self.closeDownloadsShelf = function(message, sender, sendResponse) {
        if (message.clearHistory) {
            chrome.downloads.erase({"urlRegex": ".*"});
        } else {
            chrome.downloads.setShelfEnabled(false);
            chrome.downloads.setShelfEnabled(true);
        }
    };
    self.getDownloads = function(message, sender, sendResponse) {
        chrome.downloads.search(message.query, function(items) {
            _response(message, sendResponse, {
                downloads: items
            });
        });
    };
    self.download = function(message, sender, sendResponse) {
        chrome.downloads.download({ url: message.url, saveAs: message.saveAs });
    };
    self.executeScript = function(message, sender, sendResponse) {
        chrome.tabs.executeScript(sender.tab.id, {
            frameId: sender.frameId,
            code: message.code,
            matchAboutBlank: true,
            file: message.file
        }, function(result) {
            _response(message, sendResponse, {
                response: result
            });
        });
    };
    self.tabURLAccessed = function(message, sender, sendResponse) {
        if (sender.tab) {
            var tabId = sender.tab.id;
            if (!tabURLs.hasOwnProperty(tabId)) {
                tabURLs[tabId] = {};
            }
            tabURLs[tabId][message.url] = message.title;
            return {
                active: sender.tab.active,
                index: conf.showTabIndices ? sender.tab.index + 1 : 0
            };
        } else {
            return {};
        }
    };
    self.getTabURLs = function(message, sender, sendResponse) {
        var tabURL = tabURLs[sender.tab.id] || {};
        tabURL = Object.keys(tabURL).map(function(u) {
            return {
                url: u,
                title: tabURL[u]
            };
        });
        return {
            urls: tabURL
        };
    };
    self.getTopURL = function(message, sender, sendResponse) {
        return {
            url: sender.tab ? sender.tab.url : ""
        };
    };

    function updateProxy(message, cb) {
        loadSettings(['proxyMode', 'proxy', 'autoproxy_hosts'], function(proxyConf) {
            if (message.operation === "deleteProxyPair") {
                proxyConf.proxy.splice(message.number, 1);
                proxyConf.autoproxy_hosts.splice(message.number, 1);
            } else if (message.operation === "set") {
                proxyConf.proxyMode = message.mode;
                proxyConf.proxy = message.proxy;
                proxyConf.autoproxy_hosts = message.host;
            } else {
                if (message.mode) {
                    proxyConf.proxyMode = message.mode;
                }
                if (!message.number) {
                    message.number = 0;
                }
                if (message.proxy) {
                    proxyConf.proxy[message.number] = message.proxy;
                    if (proxyConf.autoproxy_hosts.length <= message.number) {
                        proxyConf.autoproxy_hosts[message.number] = [];
                    }
                }
                if (message.host) {
                    var hostsDict = dictFromArray(proxyConf.autoproxy_hosts[message.number], 1);
                    var hosts = message.host.split(/\s*[ ,\n]\s*/);
                    if (message.operation === "toggle") {
                        hosts.forEach(function(host) {
                            if (hostsDict.hasOwnProperty(host)) {
                                delete hostsDict[host];
                            } else {
                                hostsDict[host] = 1;
                            }
                        });
                    } else if (message.operation === "add") {
                        hosts.forEach(function(host) {
                            hostsDict[host] = 1;
                        });
                    } else {
                        hosts.forEach(function(host) {
                            delete hostsDict[host];
                        });
                    }
                    proxyConf.autoproxy_hosts[message.number] = Object.keys(hostsDict);
                }
            }
            var diffSet = {
                autoproxy_hosts: proxyConf.autoproxy_hosts,
                proxyMode: proxyConf.proxyMode,
                proxy: proxyConf.proxy
            };
            _updateAndPostSettings(diffSet);
            browser._applyProxySettings(proxyConf);
            cb && cb(diffSet);
        });
    }
    self.updateProxy = function(message, sender, sendResponse) {
        updateProxy(message, function(diffSet) {
            _response(message, sendResponse, diffSet);
        });
    };
    self.setZoom = function(message, sender, sendResponse) {
        var tabId = sender.tab.id;
        var zoomFactor = message.zoomFactor * message.repeats;
        if (zoomFactor == 0) {
            chrome.tabs.setZoom(tabId, 1);
        } else {
            chrome.tabs.getZoom(tabId, function(zf) {
                chrome.tabs.setZoom(tabId, zf + zoomFactor);
            });
        }
    };
    function _removeURL(uid, cb) {
        var type = uid[0], uid = uid.substr(1);
        if (type === 'B') {
            chrome.bookmarks.remove(uid, cb);
        } else if (type === 'H') {
            chrome.history.deleteUrl({url: uid}, cb);
        } else if (type === 'T') {
            uid = uid.split(":").map(function(u) {
                return parseInt(u);
            });
            chrome.windows.update(uid[0], {
                focused: true
            }, function() {
                chrome.tabs.remove(uid[1], cb);
            });
        } else if (type === 'M') {
            loadSettings('marks', function(data) {
                delete data.marks[uid];
                _updateAndPostSettings({marks: data.marks}, cb);
            });
        }
    }
    self.removeURL = function(message, sender, sendResponse) {
        var removed = 0,
            totalToRemoved = message.uid.length,
            uid = message.uid;
        if (typeof(message.uid) === "string") {
            totalToRemoved = 1;
            uid = [ message.uid ];
        }
        function _done() {
            removed ++;
            if (removed === totalToRemoved) {
                _response(message, sendResponse, {
                    response: "Done"
                });
            }
        }
        uid.forEach(function(u) {
            _removeURL(u, _done);
        });

    };
    self.localData = function(message, sender, sendResponse) {
        if (message.data.constructor === Object) {
            chrome.storage.local.set(message.data, function() {
            });
            // broadcast the change also, such as lastKeys
            // we would set lastKeys in sync to avoid breaching chrome.storage.sync.MAX_WRITE_OPERATIONS_PER_MINUTE
            _broadcastSettings(message.data);
        } else {
            // string or array of string keys
            chrome.storage.local.get(message.data, function(data) {
                _response(message, sendResponse, {
                    data: data
                });
            });
        }
    };
    self.captureVisibleTab = function(message, sender, sendResponse) {
        chrome.tabs.captureVisibleTab(null, {format: "png"}, function(dataUrl) {
            _response(message, sendResponse, {
                dataUrl: dataUrl
            });
        });
    };
    self.getCaptureSize = function(message, sender, sendResponse) {
        var img = document.createElement( "img" );
        img.onload = function() {
            _response(message, sendResponse, {
                width: img.width,
                height: img.height
            });
        };
        chrome.tabs.captureVisibleTab(null, {format: "png"}, function(dataUrl) {
            img.src = dataUrl;
        });
    };
    self.deleteHistoryOlderThan = function(message, sender, sendResponse) {
        var days = message.days || 0, hours = message.hours || 0;
        chrome.history.deleteRange({
            startTime: 0,
            endTime: new Date().getTime() - (days * 86400 + hours * 3600) * 1000
        }, function() {
        });
    };
    function removeBookmark(url, cb) {
        chrome.bookmarks.search({
            url: url
        }, function(bookmarks) {
            bookmarks.forEach(function(b) {
                chrome.bookmarks.remove(b.id);
            });
            cb && cb();
        });
    }
    self.removeBookmark = function(message, sender, sendResponse) {
        removeBookmark(sender.tab.url);
    };
    self.getBookmark = function(message, sender, sendResponse) {
        chrome.bookmarks.search({
            url: sender.tab.url
        }, function(bookmarks) {
            _response(message, sendResponse, {
                bookmarks: bookmarks
            });
        });
    };

    self.initGist = function(message, sender, sendResponse) {
        return Gist.initGist(message.token, function(gist) {
            _response(message, sendResponse, {
                gist: gist
            });
        });
    };
    self.readComment = function(message, sender, sendResponse) {
        Gist.readComment(message.index, function(resp) {
            _response(message, sendResponse, resp);
        });
    };
    self.editComment = function(message, sender, sendResponse) {
        Gist.editComment(message.index, message.content, function(resp) {
            _response(message, sendResponse, {gistResp: resp});
        });
    };

    var _queueURLs = [];
    self.queueURLs = function(message, sender, sendResponse) {
        _queueURLs = _queueURLs.concat(message.urls);
    };
    self.getQueueURLs = function(message, sender, sendResponse) {
        return {
            queueURLs: _queueURLs
        };
    };

    self.getVoices = function(message, sender, sendResponse) {
        chrome.tts.getVoices(function(voices) {
            _response(message, sendResponse, {
                voices: voices
            });
        });
    };

    self.read = function(message, sender, sendResponse) {
        var options = message.options || {};
        options.onEvent = function(ttsEvent) {
            // https://developer.chrome.com/docs/extensions/mv2/messaging/
            // If multiple pages are listening for onMessage events, only the first to call sendResponse()
            // for a particular event will succeed in sending the response. All other responses to that event will be ignored.
            //
            // Thus for the later events after `start` we will send them in sendTabMessage.
            if (ttsEvent.type === "start") {
                _response(message, sendResponse, {
                    ttsEvent: ttsEvent
                });
            } else {
                sendTabMessage(sender.tab.id, -1, {
                    subject: 'onTtsEvent',
                    ttsEvent: ttsEvent
                });
            }
        };
        chrome.tts.speak(message.content, options);
    };
    self.stopReading = function(message, sender, sendResponse) {
        chrome.tts.stop();
    };

    self.openIncognito = function(message, sender, sendResponse) {
        chrome.windows.create({"url": message.url, "incognito": true});
    };

    var userAgent;
    function onBeforeSendHeaders(details) {
        for (var i = 0; i < details.requestHeaders.length; ++i) {
            if (details.requestHeaders[i].name === 'User-Agent') {
                details.requestHeaders[i].value = userAgent;
                break;
            }
        }
        return {requestHeaders: details.requestHeaders};
    }

    self.setUserAgent = function (message, sender, sendResponse) {
        if (message.userAgent) {
            userAgent = message.userAgent;
            chrome.webRequest.onBeforeSendHeaders.addListener(onBeforeSendHeaders, {
                urls: ["<all_urls>"]
            }, ["blocking", "requestHeaders"]);
        } else {
            chrome.webRequest.onBeforeSendHeaders.removeListener(onBeforeSendHeaders);
        }
        chrome.tabs.reload(sender.tab.id);
    };
    self.writeClipboard = function (message, sender, sendResponse) {
        navigator.clipboard.writeText(message.text)
    };
    self.readClipboard = function (message, sender, sendResponse) {
        // only for Safari
        chrome.runtime.sendNativeMessage("application.id", {message: "Clipboard.read"}, function(response) {
            _response(message, sendResponse, response);
        });
    };

    self.getContainerName = browser._getContainerName(self, _response);
    chrome.runtime.setUninstallURL("http://brookhong.github.io/2018/01/30/why-did-you-uninstall-surfingkeys.html");

    self.connectNative = function (message, sender, sendResponse) {
        if (browser.nvimServer) {
            browser.nvimServer.instance.then(({url, nm}) => {
                nm.postMessage({
                    mode: message.mode
                });
                _response(message, sendResponse, {
                    url,
                });
            }).catch((error) => {
                _response(message, sendResponse, {
                    error,
                });
            });
        }
    };
}

export {
    _save,
    dictFromArray,
    extendObject,
    getSubSettings,
    start
};
