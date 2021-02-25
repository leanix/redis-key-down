'use strict';
var redisLib = require('redis');
var AbstractLevelDOWN = require('abstract-leveldown').AbstractLevelDOWN;

var inherits = require('inherits');
var Buffer = require('safe-buffer').Buffer;

var url = require('url');
var RDIterator = require('./iterator');
var scriptsLoader = require('./scriptsLoader');
var setImmediate = require('immediate');

/**
 * @param location prefix for the database.
 */
function RedisDown(location) {
    if (!(this instanceof RedisDown)) {
        return new RedisDown(location);
    }
    AbstractLevelDOWN.call(this, {
        snapshots: false,
        seek: false
    });
    this.location = location;
}

module.exports = RedisDown;

// default number of items fetched at once during by an iterator
RedisDown.defaultHighWaterMark = 128;

// our new prototype inherits from AbstractLevelDOWN
inherits(RedisDown, AbstractLevelDOWN);

// host:port -> { db: client, locations: [] }
RedisDown.dbs = {};

// location as passed in the constructor -> connection-options
// Used by pouchdb when calling RedisDown.destroy
RedisDown.connectionByLocation = {};

/**
 * @param options: either one of
 *  - redis-client instance.
 *  - object with { redis: redis-client}
 *  - object with { port: portNumber, host: host, ... other options passed to node-redis }
 *
 * When a client is created it is reused across instances of
 * RedisDOWN unless the option `ownClient` is truthy.
 * For a client to be reused, it requires the same port, host and options.
 */
RedisDown.prototype._open = function (options, callback) {
    var originalOptions = {};
    Object.assign(originalOptions, options);
    this.highWaterMark = options.highWaterMark || RedisDown.defaultHighWaterMark;
    if (typeof options.hget === 'function') {
        this.db = options.hget;
        this.quitDbOnClose = false;
    } else if (options.redis && typeof options.redis.hget === 'function') {
        this.db = options.redis;
        this.quitDbOnClose = false;
    } else if (!options.ownClient) {
        options = _makeRedisId(this.location, options);
        this.redisId = JSON.stringify(options);
        var dbDesc = RedisDown.dbs[this.redisId];
        if (dbDesc) {
            this.db = dbDesc.db;
            dbDesc.locations.push(sanitizeLocation(this.location));
        }
    } else {
        options = _makeRedisId(this.location, options);
        this.quitDbOnClose = true;
    }
    var uriLocation = this.location;
    if (typeof RedisDown.connectionByLocation[uriLocation] === 'undefined' && originalOptions.createIfMissing === false) {
        setImmediate(function () {
            callback(new Error('Database does not exist.'));
        });
    } else {
        this.location = sanitizeLocation(this.location);
        if (!this.db) {
            if (options.port || options.host) {
                // Set return_buffers to true by default
                if (options['return_buffers'] !== false) {
                    options['return_buffers'] = true;
                }
                this.db = redisLib.createClient(options.port, options.host, options);
            } else {
                this.db = redisLib.createClient({return_buffers: true});
            }
            if (!options.ownClient) {
                RedisDown.dbs[this.redisId] = {db: this.db, locations: [this.location]};
            }
        }
        // Also store the options to connect to the database for RedisDown.destroy
        RedisDown.connectionByLocation[uriLocation] = options;
        var self = this;
        if (options && options.destroyOnOpen) {
            return this.destroy(false, function () {
                setImmediate(function () {
                    callback(null, self);
                });
            });
        }
        scriptsLoader.preload(this.db, function () {
            setImmediate(function () {
                callback(null, self);
            });
        });
    }
};

RedisDown.prototype._serializeKey = function (key) {
    return toBufferOrString(key);
}

RedisDown.prototype._serializeValue = function (value) {
    return toBufferOrString(value);
}

RedisDown.prototype._get = function (key, options, callback) {
    this.db.get(valueKey(this.location, key), function (e, v) {
        if (e) {
            return setImmediate(function callNext() {
                return callback(e);
            });
        }

        if (v === null || typeof v === undefined) {
            return setImmediate(function callNext() {
                callback(new Error('NotFound'), undefined);
            });
        }

        if (options.asBuffer === false || options.raw) {
            callback(null, String(v || ''));
        } else if (v === null || v === undefined) {
            callback(null, Buffer.from(''));
        } else {
            callback(null, Buffer.from(v));
        }
    });
};

RedisDown.prototype._put = function (key, value, opt, callback) {
    if (typeof value === 'undefined' || value === null) {
        value = '';
    }
    this.__exec(this.__appendPutCmd([], key, value), callback);
};

RedisDown.prototype._del = function (key, opt, cb) {
    this.__exec(this.__appendDelCmd([], key), cb);
};

RedisDown.prototype._batch = function (operationArray, options, callback) {
    var commandList = [];
    for (var i = 0; i < operationArray.length; i++) {
        var operation = operationArray[i];
        if (operation.type === 'put') {
            this.__appendPutCmd(commandList, operation.key, operation.value, operation.prefix);
        } else if (operation.type === 'del') {
            this.__appendDelCmd(commandList, operation.key, operation.prefix);
        } else {
            return callback(new Error('Unknow type of operation ' + JSON.stringify(operation)));
        }
    }
    this.__exec(commandList, callback);
};

RedisDown.prototype.__getPrefix = function (prefix) {
    return prefix || this.location;
};

RedisDown.prototype.__appendPutCmd = function (commandList, key, value, prefix) {
    var resolvedPrefix = this.__getPrefix(prefix);
    commandList.push(['set', valueKey(resolvedPrefix, key), value === undefined ? '' : value]);
    commandList.push(['zadd', resolvedPrefix + ':z', 0, key]);
    return commandList;
};

RedisDown.prototype.__appendDelCmd = function (commandList, key, prefix) {
    var resolvedPrefix = this.__getPrefix(prefix);
    commandList.push(['del', valueKey(resolvedPrefix, key)]);
    commandList.push(['zrem', resolvedPrefix + ':z', key]);
    return commandList;
};
RedisDown.prototype.__exec = function (commandList, callback) {
    this.db.multi(commandList).exec(callback);
};

RedisDown.prototype._close = function (callback) {
    this.closed = true;
    if (this.quitDbOnClose === false) {
        return setImmediate(callback);
    }
    if (this.quitDbOnClose !== true) {
        // close the client only if it is not used by others:
        var dbDesc = RedisDown.dbs[this.redisId];
        if (dbDesc) {
            var location = this.location;
            dbDesc.locations = dbDesc.locations.filter(function (loc) {
                return loc !== location;
            });
            if (dbDesc.locations.length !== 0) {
                // a still used by another RedisDOWN
                return setImmediate(callback);
            }
            delete RedisDown.dbs[this.redisId];
        }
    }
    try {
        this.db.quit();
    } catch (x) {
        console.log('Error attempting to quit the redis client', x);
    }
    setImmediate(callback);
};

RedisDown.prototype._iterator = function (options) {
    return new RDIterator(this, options);
};

// Special operations
/**
 * Opens a new redis client del the hset.
 * Quit the client.
 * Callbacks
 */
RedisDown.destroy = function (location, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = RedisDown.connectionByLocation[location];
        delete RedisDown.connectionByLocation[location];
    }
    if (!options) {
        return callback(new Error('No connection registered for "' + location + '"'));
    }
    var sanitizedLocation = sanitizeLocation(location);
    var client = redisLib.createClient(options.port, options.host, options);
    client.del(sanitizedLocation + ':z', function (e) {
        client.quit();
        callback(e);
    });
};
/**
 * @param doClose: optional parameter, by default true to close the client
 */
RedisDown.prototype.destroy = function (doClose, callback) {
    if (!callback && typeof doClose === 'function') {
        callback = doClose;
        doClose = true;
    }
    var self = this;
    this.db.del(this.location + ':z', function (e) {
        if (doClose) {
            self.close(callback);
        } else {
            callback();
        }
    });
};

/**
 * Internal: generate the options for redis.
 * create an identifier for a redis client from the options passed to _open.
 * when the identifier is identical, it is safe to reuse the same client.
 */
function _makeRedisId(location, options) {
    var redisIdOptions = ['host', 'port', 'tls', 'password',
        'parser', 'return_buffers', 'detect_buffers', 'socket_nodelay', 'no_ready_check',
        'enable_offline_queue', 'retry_max_delay', 'connect_timeout', 'max_attempts'
    ];
    var redisOptions = {};
    redisIdOptions.forEach(function (opt) {
        if (options[opt] !== undefined && options[opt] !== null) {
            redisOptions[opt] = options[opt];
        }
    });
    if (options.url || (location && location.indexOf('://') !== -1)) {
        var redisURL = url.parse(options.url || location);
        redisOptions.port = redisURL.port;
        redisOptions.host = redisURL.hostname;
        if (redisURL.auth) {
            redisOptions.auth_pass = redisURL.auth.split(':')[1];
        }
    }
    return redisOptions;
}

function sanitizeLocation(location) {
    if (!location) {
        return 'rd';
    }
    if (location.indexOf('://')) {
        location = url.parse(location).pathname || 'rd';
    }
    if (location.charAt(0) === '/') {
        return location.substring(1);
    }
    // Keep the hash delimited by curly brackets safe
    // as it is used by redis-cluster to force the selection of a slot.
    if (location.indexOf('%7B') === 0 && location.indexOf('%7D') > 0) {
        location = location.replace('%7B', '{').replace('%7D', '}');
    }
    return location;
}

function toBufferOrString(key) {
    if (Buffer.isBuffer(key)) {
        return key;
    } else {
        return key.toString();
    }
}

function valueKey(location, key) {
    return location + '$' + key;
}

RedisDown.reset = function (callback) {
    for (var k in RedisDown.dbs) {
        if (RedisDown.dbs.hasOwnProperty(k)) {
            try {
                var db = RedisDown.dbs[k].db;
                db.quit();
            } catch (x) {
            }
        }
    }
    if (callback) {
        return callback();
    }
};
