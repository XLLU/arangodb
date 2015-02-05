/*global require, fail, assertEqual, assertTrue, assertFalse, assertNull, arango */

////////////////////////////////////////////////////////////////////////////////
/// @brief test the replication
///
/// @file
///
/// DISCLAIMER
///
/// Copyright 2010-2012 triagens GmbH, Cologne, Germany
///
/// Licensed under the Apache License, Version 2.0 (the "License");
/// you may not use this file except in compliance with the License.
/// You may obtain a copy of the License at
///
///     http://www.apache.org/licenses/LICENSE-2.0
///
/// Unless required by applicable law or agreed to in writing, software
/// distributed under the License is distributed on an "AS IS" BASIS,
/// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
/// See the License for the specific language governing permissions and
/// limitations under the License.
///
/// Copyright holder is triAGENS GmbH, Cologne, Germany
///
/// @author Jan Steemann
/// @author Copyright 2013, triAGENS GmbH, Cologne, Germany
////////////////////////////////////////////////////////////////////////////////

var jsunity = require("jsunity");
var arangodb = require("org/arangodb");
var errors = arangodb.errors;
var db = arangodb.db;

var replication = require("org/arangodb/replication");
var console = require("console");
var internal = require("internal");
var masterEndpoint = arango.getEndpoint();
var slaveEndpoint = masterEndpoint.replace(/:3(\d+)$/, ':4$1');

// -----------------------------------------------------------------------------
// --SECTION--                                                 replication tests
// -----------------------------------------------------------------------------

////////////////////////////////////////////////////////////////////////////////
/// @brief test suite
////////////////////////////////////////////////////////////////////////////////

function ReplicationSuite () {
  "use strict";
  var cn  = "UnitTestsReplication";
  var cn2 = "UnitTestsReplication2";

  // these must match the values in the Makefile!
  var replicatorUser = "replicator-user";
  var replicatorPassword = "replicator-password";

  var connectToMaster = function () {
    arango.reconnect(masterEndpoint, db._name(), replicatorUser, replicatorPassword);
  };

  var connectToSlave = function () {
    arango.reconnect(slaveEndpoint, db._name(), "root", "");
  };

  var collectionChecksum = function (name) {
    var c = db._collection(name).checksum(true, true);
    return c.checksum;
  };

  var collectionCount = function (name) {
    return db._collection(name).count();
  };

  var compareTicks = function (l, r) {
    var i;
    if (l === null) {
      l = "0";
    }
    if (r === null) {
      r = "0";
    }
    if (l.length !== r.length) {
      return l.length - r.length < 0 ? -1 : 1;
    }

    // length is equal
    for (i = 0; i < l.length; ++i) {
      if (l[i] !== r[i]) {
        return l[i] < r[i] ? -1 : 1;
      }
    }

    return 0;
  };

  var compare = function (masterFunc, slaveFunc, applierConfiguration) {
    var state = { };

    db._flushCache();
    masterFunc(state);

    connectToSlave();
    replication.applier.stop();

    internal.wait(1, false);

    var includeSystem = true;
    var restrictType = "";
    var restrictCollections = [ ];
    
    if (typeof applierConfiguration === 'object') {
      if (applierConfiguration.hasOwnProperty("includeSystem")) {
        includeSystem = applierConfiguration.includeSystem;
      }
      if (applierConfiguration.hasOwnProperty("restrictType")) {
        restrictType = applierConfiguration.restrictType;
      }
      if (applierConfiguration.hasOwnProperty("restrictCollections")) {
        restrictCollections = applierConfiguration.restrictCollections;
      }
    }

    var syncResult = replication.sync({
      endpoint: masterEndpoint,
      username: replicatorUser,
      password: replicatorPassword,
      verbose: true,
      includeSystem: includeSystem,
      restrictType: restrictType,
      restrictCollections: restrictCollections
    });

    assertTrue(syncResult.hasOwnProperty('lastLogTick'));

    if (typeof applierConfiguration === 'object') {
      console.log("using special applier configuration: " + JSON.stringify(applierConfiguration));
    }

    applierConfiguration = applierConfiguration || { };
    applierConfiguration.endpoint = masterEndpoint;
    applierConfiguration.username = replicatorUser;
    applierConfiguration.password = replicatorPassword;

    if (! applierConfiguration.hasOwnProperty('chunkSize')) {
      applierConfiguration.chunkSize = 16384;
    }

    replication.applier.properties(applierConfiguration);
    replication.applier.start(syncResult.lastLogTick);

    var printed = false;

    while (1) {
      var slaveState = replication.applier.state();

      if (! slaveState.state.running || slaveState.state.lastError.errorNum > 0) {
        break;
      }

      if (compareTicks(slaveState.state.lastAppliedContinuousTick, syncResult.lastLogTick) > 0 ||
          compareTicks(slaveState.state.lastProcessedContinuousTick, syncResult.lastLogTick) > 0 ||
          compareTicks(slaveState.state.lastAvailableContinuousTick, syncResult.lastLogTick) > 0) {
        break;
      }

      if (! printed) {
        console.log("waiting for slave to catch up");
        printed = true;
      }
      internal.wait(1.0, false);
    }

    db._flushCache();
    slaveFunc(state);
  };

  return {

////////////////////////////////////////////////////////////////////////////////
/// @brief set up
////////////////////////////////////////////////////////////////////////////////

    setUp : function () {
      connectToMaster();

      db._drop(cn);
      db._drop(cn2);
      db._drop("_test");
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief tear down
////////////////////////////////////////////////////////////////////////////////

    tearDown : function () {
      connectToMaster();

      db._drop(cn);
      db._drop(cn2);
      db._drop("_test");

      connectToSlave();
      replication.applier.stop();
      db._drop(cn);
      db._drop(cn2);
      db._drop("_test");
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test invalid credentials
////////////////////////////////////////////////////////////////////////////////

    testInvalidCredentials1 : function () {
      var configuration = {
        endpoint: masterEndpoint,
        username: replicatorUser,
        password: replicatorPassword + "xx" // invalid
      };

      try {
        replication.applier.properties(configuration);
      }
      catch (err) {
        require("internal").print(err);
        assertEqual(errors.ERROR_HTTP_UNAUTHORIZED.code, err.errorNum);
      }
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test invalid credentials
////////////////////////////////////////////////////////////////////////////////

    testInvalidCredentials2 : function () {
      var configuration = {
        endpoint: masterEndpoint,
        username: replicatorUser + "xx", // invalid
        password: replicatorPassword
      };

      try {
        replication.applier.properties(configuration);
      }
      catch (err) {
        assertEqual(errors.ERROR_HTTP_UNAUTHORIZED.code, err.errorNum);
      }
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test invalid credentials
////////////////////////////////////////////////////////////////////////////////

    testInvalidCredentials3 : function () {
      var configuration = {
        endpoint: masterEndpoint,
        username: "root",
        password: "abc"
      };

      try {
        replication.applier.properties(configuration);
      }
      catch (err) {
        assertEqual(errors.ERROR_HTTP_UNAUTHORIZED.code, err.errorNum);
      }
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test few documents
////////////////////////////////////////////////////////////////////////////////

    testFew : function () {
      connectToMaster();

      compare(
        function (state) {
          var c = db._create(cn), i;

          for (i = 0; i < 5000; ++i) {
            c.save({ "value" : i });
          }

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(5000, state.count);
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test many documents
////////////////////////////////////////////////////////////////////////////////

    testMany : function () {
      connectToMaster();

      compare(
        function (state) {
          var c = db._create(cn), i;

          for (i = 0; i < 50000; ++i) {
            c.save({ "value" : i });
          }

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(50000, state.count);
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test many documents
////////////////////////////////////////////////////////////////////////////////

    testManyMore : function () {
      connectToMaster();

      compare(
        function (state) {
          var c = db._create(cn), i;

          for (i = 0; i < 150000; ++i) {
            c.save({ "value" : i });
          }

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(150000, state.count);
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test big markers
////////////////////////////////////////////////////////////////////////////////

    testBigMarkersArray : function () {
      connectToMaster();

      compare(
        function (state) {
          var c = db._create(cn), i;
          var doc = { };
          for (i = 0; i < 1000; ++i) {
            doc["test" + i] = "the quick brown foxx jumped over the LAZY dog";
          }

          for (i = 0; i < 100; ++i) {
            c.save({ "value" : i, "values": doc });
          }

          var d = c.any();
          assertEqual(1000, Object.keys(d.values).length);

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(100, state.count);
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test big markers
////////////////////////////////////////////////////////////////////////////////

    testBigMarkersList : function () {
      connectToMaster();

      compare(
        function (state) {
          var c = db._create(cn), i;
          var doc = [ ];
          for (i = 0; i < 1000; ++i) {
            doc.push("the quick brown foxx jumped over the LAZY dog");
          }

          for (i = 0; i < 100; ++i) {
            c.save({ "value" : i, "values": doc });
          }

          var d = c.any();
          assertEqual(1000, d.values.length);

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(100, state.count);
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test heterogenous markers
////////////////////////////////////////////////////////////////////////////////

    testHeterogenousMarkers : function () {
      connectToMaster();

      compare(
        function (state) {
          var c = db._create(cn), i;

          for (i = 0; i < 1000; ++i) {
            var doc = { };
            doc["test" + i] = "the quick brown foxx jumped over the LAZY dog";
            c.save({ "value" : i, "values": doc });
          }

          var d = c.any();
          assertEqual(1, Object.keys(d.values).length);

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(1000, state.count);
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test empty markers
////////////////////////////////////////////////////////////////////////////////

    testEmptyMarkers : function () {
      connectToMaster();

      compare(
        function (state) {
          var c = db._create(cn), i;

          for (i = 0; i < 1000; ++i) {
            c.save({ });
          }

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(1000, state.count);
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test documents
////////////////////////////////////////////////////////////////////////////////

    testDocuments1 : function () {
      compare(
        function (state) {
          var c = db._create(cn), i;

          for (i = 0; i < 1000; ++i) {
            c.save({ "value" : i,
                     "foo" : true,
                     "bar" : [ i , false ],
                     "value2" : null,
                     "mydata" : { "test" : [ "abc", "def" ] } });
          }

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(1000, state.count);
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));
        }
      );
    },


////////////////////////////////////////////////////////////////////////////////
/// @brief test documents
////////////////////////////////////////////////////////////////////////////////

    testDocuments2 : function () {
      compare(
        function (state) {
          var c = db._create(cn), i;

          for (i = 0; i < 1000; ++i) {
            c.save({ "abc" : true, "_key" : "test" + i });
            if (i % 3 === 0) {
              c.remove(c.last());
            }
            else if (i % 5 === 0) {
              c.update("test" + i, { "def" : "hifh" });
            }
          }

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(666, state.count);
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test documents
////////////////////////////////////////////////////////////////////////////////

    testDocuments3 : function () {
      compare(
        function (state) {
          var c = db._create(cn), i;

          for (i = 0; i < 50000; ++i) {
            c.save({ "_key" : "test" + i, "foo" : "bar", "baz" : "bat" });
          }

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(50000, state.count);
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test documents
////////////////////////////////////////////////////////////////////////////////

    testDocuments4 : function () {
      compare(
        function (state) {
          var c = db._create(cn), i;

          for (i = 0; i < 50000; ++i) {
            c.save({ "_key" : "test" + i, "foo" : "bar", "baz" : "bat" });
          }

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(50000, state.count);
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));
        },
        {
          chunkSize: 512
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test documents
////////////////////////////////////////////////////////////////////////////////

    testDocuments5 : function () {
      compare(
        function (state) {
          var c = db._create(cn), i;

          for (i = 0; i < 100; ++i) {
            c.save({ "abc" : true, "_key" : "test" + i });
            if (i % 3 === 0) {
              c.remove(c.last());
            }
            else if (i % 5 === 0) {
              c.update("test" + i, { "def" : "hifh" });
            }
          }

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(66, state.count);
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test edges
////////////////////////////////////////////////////////////////////////////////

    testEdges : function () {
      compare(
        function (state) {
          var v = db._create(cn), i;
          var e = db._createEdgeCollection(cn2);

          for (i = 0; i < 1000; ++i) {
            v.save({ "_key" : "test" + i });
          }

          for (i = 0; i < 5000; i += 10) {
            e.save(cn + "/test" + i, cn + "/test" + i, { "foo" : "bar", "value" : i });
          }

          state.checksum1 = collectionChecksum(cn);
          state.count1 = collectionCount(cn);
          assertEqual(1000, state.count1);

          state.checksum2 = collectionChecksum(cn2);
          state.count2 = collectionCount(cn2);
          assertEqual(500, state.count2);
        },
        function (state) {
          assertEqual(state.count1, collectionCount(cn));
          assertEqual(state.checksum1, collectionChecksum(cn));

          assertEqual(state.count2, collectionCount(cn2));
          assertEqual(state.checksum2, collectionChecksum(cn2));
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test transactions
////////////////////////////////////////////////////////////////////////////////

    testTransaction1 : function () {
      compare(
        function (state) {
          var c = db._create(cn), i;

          try {
            db._executeTransaction({
              collections: {
                write: cn
              },
              action: function () {
                for (i = 0; i < 1000; ++i) {
                  c.save({ "_key" : "test" + i });
                }

                throw "rollback!";
              }
            });
            fail();
          }
          catch (err) {
          }

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(0, state.count);
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test transactions
////////////////////////////////////////////////////////////////////////////////

    testTransaction2 : function () {
      compare(
        function (state) {
          var c = db._create(cn), i;

          for (i = 0; i < 1000; ++i) {
            c.save({ "_key" : "test" + i });
          }

          try {
            db._executeTransaction({
              collections: {
                write: cn
              },
              action: function () {
                for (i = 0; i < 1000; ++i) {
                  c.remove("test" + i);
                }
              }
            });
            fail();
          }
          catch (err) {

          }

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(1000, state.count);
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test transactions
////////////////////////////////////////////////////////////////////////////////

    testTransaction3 : function () {
      compare(
        function (state) {
          db._create(cn);

          db._executeTransaction({
            collections: {
              write: cn
            },
            action: function (params) {
              var c = require("internal").db._collection(params.cn), i;

              for (i = 0; i < 1000; ++i) {
                c.save({ "_key" : "test" + i });
              }
            },
            params: { "cn": cn },
          });

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(1000, state.count);
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test transactions
////////////////////////////////////////////////////////////////////////////////

    testTransaction4 : function () {
      compare(
        function (state) {
          db._create(cn);

          db._executeTransaction({
            collections: {
              write: cn
            },
            action: function (params) {
              var c = require("internal").db._collection(params.cn), i;

              for (i = 0; i < 1000; ++i) {
                c.save({ "_key" : "test" + i });
              }

              for (i = 0; i < 1000; ++i) {
                c.update("test" + i, { "foo" : "bar" + i });
              }

              for (i = 0; i < 1000; ++i) {
                c.update("test" + i, { "foo" : "baz" + i });
              }

              for (i = 0; i < 1000; i += 10) {
                c.remove("test" + i);
              }
            },
            params: { "cn": cn },
          });

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(900, state.count);
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test big transaction
////////////////////////////////////////////////////////////////////////////////

    testTransactionBig : function () {
      compare(
        function (state) {
          db._create(cn);

          db._executeTransaction({
            collections: {
              write: cn
            },
            action: function (params) {
              var c = require("internal").db._collection(params.cn), i;

              for (i = 0; i < 50000; ++i) {
                c.save({ "_key" : "test" + i, value : i });
                c.update("test" + i, { value : i + 1 });

                if (i % 5 === 0) {
                  c.remove("test" + i);
                }
              }
            },
            params: { "cn" : cn },
          });

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(40000, state.count);
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));
        },
        {
          chunkSize: 2048
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test transactions
////////////////////////////////////////////////////////////////////////////////

    testTransactionMulti : function () {
      compare(
        function (state) {
          db._create(cn);
          db._create(cn2);

          db._executeTransaction({
            collections: {
              write: [ cn, cn2 ]
            },
            action: function (params) {
              var c1 = require("internal").db._collection(params.cn);
              var c2 = require("internal").db._collection(params.cn2);
              var i;

              for (i = 0; i < 1000; ++i) {
                c1.save({ "_key" : "test" + i });
                c2.save({ "_key" : "test" + i, "foo": "bar" });
              }

              for (i = 0; i < 1000; ++i) {
                c1.update("test" + i, { "foo" : "bar" + i });
              }

              for (i = 0; i < 1000; ++i) {
                c1.update("test" + i, { "foo" : "baz" + i });
                c2.update("test" + i, { "foo" : "baz" + i });
              }

              for (i = 0; i < 1000; i += 10) {
                c1.remove("test" + i);
                c2.remove("test" + i);
              }
            },
            params: { "cn": cn, "cn2": cn2 },
          });

          state.checksum1 = collectionChecksum(cn);
          state.checksum2 = collectionChecksum(cn2);
          state.count1 = collectionCount(cn);
          state.count2 = collectionCount(cn2);
          assertEqual(900, state.count1);
          assertEqual(900, state.count2);
        },
        function (state) {
          assertEqual(state.count1, collectionCount(cn));
          assertEqual(state.count2, collectionCount(cn2));
          assertEqual(state.checksum1, collectionChecksum(cn));
          assertEqual(state.checksum2, collectionChecksum(cn2));
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test transactions
////////////////////////////////////////////////////////////////////////////////

    testTransactionAbort : function () {
      compare(
        function (state) {
          db._create(cn);
          db._create(cn2);

          db._collection(cn).save({ foo: "bar" });
          db._collection(cn2).save({ bar: "baz" });

          try {
            db._executeTransaction({
              collections: {
                write: [ cn, cn2 ]
              },
              action: function (params) {
                var c1 = require("internal").db._collection(params.cn);
                var c2 = require("internal").db._collection(params.cn2);
                var i;

                for (i = 0; i < 1000; ++i) {
                  c1.save({ "_key" : "test" + i });
                  c2.save({ "_key" : "test" + i, "foo": "bar" });
                }

                for (i = 0; i < 1000; ++i) {
                  c1.update("test" + i, { "foo" : "bar" + i });
                }

                for (i = 0; i < 1000; ++i) {
                  c1.update("test" + i, { "foo" : "baz" + i });
                  c2.update("test" + i, { "foo" : "baz" + i });
                }

                for (i = 0; i < 1000; i += 10) {
                  c1.remove("test" + i);
                  c2.remove("test" + i);
                }

                throw "rollback!";
              },
              params: { "cn": cn, "cn2": cn2 },
            });
            fail();
          }
          catch (err) {
          }

          state.checksum1 = collectionChecksum(cn);
          state.checksum2 = collectionChecksum(cn2);
          state.count1 = collectionCount(cn);
          state.count2 = collectionCount(cn2);
          assertEqual(1, state.count1);
          assertEqual(1, state.count2);
        },
        function (state) {
          assertEqual(state.count1, collectionCount(cn));
          assertEqual(state.count2, collectionCount(cn2));
          assertEqual(state.checksum1, collectionChecksum(cn));
          assertEqual(state.checksum2, collectionChecksum(cn2));
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test rename collection
////////////////////////////////////////////////////////////////////////////////

    testRenameCollection1 : function () {
      compare(
        function (state) {
          var c = db._create(cn, {
            isVolatile : true,
            waitForSync : false,
            doCompact : false,
            journalSize : 1048576,
            keyOptions : {
              allowUserKeys : false
            },
          });

          c.rename(cn2);

          state.cid = c._id;
          state.properties = c.properties();
        },
        function (state) {
          try {
            db._collection(cn).properties();
            fail();
          }
          catch (err) {
            // original collection was renamed
          }

          var properties = db._collection(cn2).properties();
          assertEqual(state.cid, db._collection(cn2)._id);
          assertEqual(cn2, db._collection(cn2).name());
          assertTrue(properties.isVolatile);
          assertFalse(properties.waitForSync);
          assertFalse(properties.deleted);
          assertFalse(properties.doCompact);
          assertEqual(1048576, properties.journalSize);
          assertFalse(properties.keyOptions.allowUserKeys);
          assertEqual("traditional", properties.keyOptions.type);
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test rename collection
////////////////////////////////////////////////////////////////////////////////

    testRenameCollection2 : function () {
      compare(
        function (state) {
          var c = db._create(cn);
          c.rename(cn2);
          c.rename(cn);

          state.cid = c._id;
          state.properties = c.properties();
        },
        function (state) {
          try {
            db._collection(cn2).properties();
            fail();
          }
          catch (err) {
            // collection was renamed
          }

          assertEqual(state.cid, db._collection(cn)._id);
          assertEqual(cn, db._collection(cn).name());
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test change collection
////////////////////////////////////////////////////////////////////////////////

    testChangeCollection1 : function () {
      compare(
        function (state) {
          var c = db._create(cn, {
            waitForSync : false,
            doCompact : false,
            journalSize : 1048576
          });

          var properties = c.properties();
          assertFalse(properties.waitForSync);
          assertFalse(properties.doCompact);
          assertEqual(1048576, properties.journalSize);

          properties = c.properties({ waitForSync: true, doCompact: true, journalSize: 2097152 });
          assertTrue(properties.waitForSync);
          assertTrue(properties.doCompact);
          assertEqual(2097152, properties.journalSize);

          state.cid = c._id;
          state.properties = c.properties();
        },
        function (state) {
          var properties = db._collection(cn).properties();
          assertEqual(state.cid, db._collection(cn)._id);
          assertEqual(cn, db._collection(cn).name());
          assertTrue(properties.waitForSync);
          assertTrue(properties.doCompact);
          assertEqual(2097152, properties.journalSize);
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test change collection
////////////////////////////////////////////////////////////////////////////////

    testChangeCollection2 : function () {
      compare(
        function (state) {
          var c = db._create(cn, {
            waitForSync : true,
            doCompact : true,
            journalSize : 2097152
          });

          var properties = c.properties();
          assertTrue(properties.waitForSync);
          assertTrue(properties.doCompact);
          assertEqual(2097152, properties.journalSize);

          properties = c.properties({ waitForSync: false, doCompact: false, journalSize: 1048576 });
          assertFalse(properties.waitForSync);
          assertFalse(properties.doCompact);
          assertEqual(1048576, properties.journalSize);

          state.cid = c._id;
          state.properties = c.properties();
        },
        function (state) {
          var properties = db._collection(cn).properties();
          assertEqual(state.cid, db._collection(cn)._id);
          assertEqual(cn, db._collection(cn).name());
          assertFalse(properties.waitForSync);
          assertFalse(properties.doCompact);
          assertEqual(1048576, properties.journalSize);
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test create collection
////////////////////////////////////////////////////////////////////////////////

    testCreateCollection1 : function () {
      compare(
        function (state) {
          var c = db._create(cn, {
            isVolatile : true,
            waitForSync : false,
            doCompact : false,
            journalSize : 1048576
          });

          state.cid = c._id;
          state.properties = c.properties();
        },
        function (state) {
          var properties = db._collection(cn).properties();
          assertEqual(state.cid, db._collection(cn)._id);
          assertEqual(cn, db._collection(cn).name());
          assertTrue(properties.isVolatile);
          assertFalse(properties.waitForSync);
          assertFalse(properties.deleted);
          assertFalse(properties.doCompact);
          assertEqual(1048576, properties.journalSize);
          assertTrue(properties.keyOptions.allowUserKeys);
          assertEqual("traditional", properties.keyOptions.type);
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test create collection
////////////////////////////////////////////////////////////////////////////////

    testCreateCollection2 : function () {
      compare(
        function (state) {
          var c = db._create(cn, {
            keyOptions : {
              type : "autoincrement",
              allowUserKeys : false
            },
            isVolatile : false,
            waitForSync : true,
            doCompact : true,
            journalSize : 2097152
          });

          state.cid = c._id;
          state.properties = c.properties();
        },
        function (state) {
          var properties = db._collection(cn).properties();
          assertEqual(state.cid, db._collection(cn)._id);
          assertEqual(cn, db._collection(cn).name());
          assertFalse(properties.isVolatile);
          assertTrue(properties.waitForSync);
          assertFalse(properties.deleted);
          assertTrue(properties.doCompact);
          assertEqual(2097152, properties.journalSize);
          assertFalse(properties.keyOptions.allowUserKeys);
          assertEqual("autoincrement", properties.keyOptions.type);
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test drop collection
////////////////////////////////////////////////////////////////////////////////

    testDropCollection : function () {
      compare(
        function (state) {
          var c = db._create(cn);
          c.drop();
        },
        function (state) {
          assertNull(db._collection(cn));
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test cap constraint
////////////////////////////////////////////////////////////////////////////////

    testCapConstraint : function () {
      compare(
        function (state) {
          var c = db._create(cn), i;
          c.ensureCapConstraint(128);

          for (i = 0; i < 1000; ++i) {
            c.save({ "_key" : "test" + i });
          }
          state.last = c.last(3);

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(128, state.count);
          assertEqual("test999", state.last[0]._key);
          assertEqual("test998", state.last[1]._key);
          assertEqual("test997", state.last[2]._key);

          state.idx = c.getIndexes()[1];
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));
          assertEqual(state.last, db._collection(cn).last(3));

          assertEqual(state.idx.id, db._collection(cn).getIndexes()[1].id);
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test hash index
////////////////////////////////////////////////////////////////////////////////

    testUniqueConstraint : function () {
      compare(
        function (state) {
          var c = db._create(cn), i;
          c.ensureHashIndex("a", "b");

          for (i = 0; i < 1000; ++i) {
            c.save({ "_key" : "test" + i, "a" : parseInt(i / 2), "b" : i });
          }

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(1000, state.count);

          state.idx = c.getIndexes()[1];
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));

          var idx = db._collection(cn).getIndexes()[1];
          assertEqual(state.idx.id, idx.id);
          assertEqual("hash", state.idx.type);
          assertFalse(state.idx.unique);
          assertEqual([ "a" ], state.idx.fields);
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test unique constraint
////////////////////////////////////////////////////////////////////////////////

    testUniqueConstraint2 : function () {
      compare(
        function (state) {
          var c = db._create(cn), i;
          c.ensureUniqueConstraint("a");

          for (i = 0; i < 1000; ++i) {
            try {
              c.save({ "_key" : "test" + i, "a" : parseInt(i / 2) });
            }
            catch (err) {
            }
          }

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(500, state.count);

          state.idx = c.getIndexes()[1];
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));

          var idx = db._collection(cn).getIndexes()[1];
          assertEqual(state.idx.id, idx.id);
          assertEqual("hash", state.idx.type);
          assertTrue(state.idx.unique);
          assertEqual([ "a" ], state.idx.fields);
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test skiplist
////////////////////////////////////////////////////////////////////////////////

    testSkiplist : function () {
      compare(
        function (state) {
          var c = db._create(cn), i;
          c.ensureSkiplist("a", "b");

          for (i = 0; i < 1000; ++i) {
            c.save({ "_key" : "test" + i, "a" : parseInt(i / 2), "b" : i });
          }

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(1000, state.count);

          state.idx = c.getIndexes()[1];
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));

          var idx = db._collection(cn).getIndexes()[1];
          assertEqual(state.idx.id, idx.id);
          assertEqual("skiplist", state.idx.type);
          assertFalse(state.idx.unique);
          assertEqual([ "a", "b" ], state.idx.fields);
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test unique skiplist
////////////////////////////////////////////////////////////////////////////////

    testUniqueSkiplist : function () {
      compare(
        function (state) {
          var c = db._create(cn), i;
          c.ensureUniqueSkiplist("a");

          for (i = 0; i < 1000; ++i) {
            try {
              c.save({ "_key" : "test" + i, "a" : parseInt(i / 2) });
            }
            catch (err) {
            }
          }

          state.checksum = collectionChecksum(cn);
          state.count = collectionCount(cn);
          assertEqual(500, state.count);

          state.idx = c.getIndexes()[1];
        },
        function (state) {
          assertEqual(state.count, collectionCount(cn));
          assertEqual(state.checksum, collectionChecksum(cn));

          var idx = db._collection(cn).getIndexes()[1];
          assertEqual(state.idx.id, idx.id);
          assertEqual("skiplist", state.idx.type);
          assertTrue(state.idx.unique);
          assertEqual([ "a" ], state.idx.fields);
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test system collection
////////////////////////////////////////////////////////////////////////////////

    testSystemCollectionWithDefaults : function () {
      compare(
        function (state) {
          var c = db._create("_test", { isSystem: true });
          c.save({ _key: "UnitTester", testValue: 42 });
        },
        function (state) {
          var doc = db._test.document("UnitTester");
          assertEqual(42, doc.testValue);
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test system collection
////////////////////////////////////////////////////////////////////////////////

    testSystemCollectionExcludeSystem : function () {
      compare(
        function (state) {
          var c = db._create("_test", { isSystem: true });
          c.save({ _key: "UnitTester", testValue: 42 });
        },
        function (state) {
          assertNull(db._collection("_test"));
        },
        {
          includeSystem: false
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test system collection
////////////////////////////////////////////////////////////////////////////////

    testSystemCollectionExcludeCollection : function () {
      compare(
        function (state) {
          var c = db._create("_test", { isSystem: true });
          c.save({ _key: "UnitTester", testValue: 42 });
        },
        function (state) {
          assertNull(db._collection("_test"));
        },
        {
          includeSystem: true,
          restrictType: "exclude",
          restrictCollections: [ "_test" ]
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test system collection
////////////////////////////////////////////////////////////////////////////////

    testSystemCollectionIncludeCollection : function () {
      compare(
        function (state) {
          var c = db._create("_test", { isSystem: true });
          c.save({ _key: "UnitTester", testValue: 42 });
        },
        function (state) {
          var doc = db._test.document("UnitTester");
          assertEqual(42, doc.testValue);
        },
        {
          includeSystem: true,
          restrictType: "include",
          restrictCollections: [ "_test" ]
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test include/exclude collection
////////////////////////////////////////////////////////////////////////////////

    testCollectionIncludeCollection : function () {
      compare(
        function (state) {
          var c1 = db._create(cn);
          var c2 = db._create(cn2);
          c1.save({ _key: "UnitTester", testValue: 42 });
          c2.save({ _key: "UnitTester", testValue: 23 });
        },
        function (state) {
          var doc = db[cn].document("UnitTester");
          assertEqual(42, doc.testValue);
          assertNull(db._collection(cn2));
        },
        {
          restrictType: "include",
          restrictCollections: [ cn ]
        }
      );
    },

////////////////////////////////////////////////////////////////////////////////
/// @brief test include/exclude collection
////////////////////////////////////////////////////////////////////////////////

    testCollectionExcludeCollection : function () {
      compare(
        function (state) {
          var c1 = db._create(cn);
          var c2 = db._create(cn2);
          c1.save({ _key: "UnitTester", testValue: 42 });
          c2.save({ _key: "UnitTester", testValue: 23 });
        },
        function (state) {
          var doc = db[cn].document("UnitTester");
          assertEqual(42, doc.testValue);
          assertNull(db._collection(cn2));
        },
        {
          restrictType: "exclude",
          restrictCollections: [ cn2 ]
        }
      );
    }

  };
}

// -----------------------------------------------------------------------------
// --SECTION--                                                              main
// -----------------------------------------------------------------------------

////////////////////////////////////////////////////////////////////////////////
/// @brief executes the test suite
////////////////////////////////////////////////////////////////////////////////

jsunity.run(ReplicationSuite);

return jsunity.done();

// Local Variables:
// mode: outline-minor
// outline-regexp: "^\\(/// @brief\\|/// @addtogroup\\|// --SECTION--\\|/// @page\\|/// @}\\)"
// End:
