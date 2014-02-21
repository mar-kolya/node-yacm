var _ = require('underscore');
var http = require('http');
var fs = require('fs');
var cluster = require('cluster');
var util = require('util');
var assert = require('assert');

var testFile = './test/test.txt~';

describe('Basic usage - run/reload/shutdown', function() {
  this.timeout(10000);
  var master = require('../lib/yacm');

  it('basic default usage', function(done) {
    cluster.setupMaster({exec: './test/worker.js.helper'});
    fs.writeFileSync(testFile, 'test');
    var files = [testFile];
    master.run({watchFiles: files});
    setTimeout(function() {
      assert.equal(_.keys(cluster.workers).length, 2);
      var oldPids = _.map(_.values(cluster.workers),
                             function(worker) {
                               return worker.process.pid;
                             });
      fs.writeFileSync(testFile, 'new-test');
      setTimeout(function() {
        var newPids = _.map(_.values(cluster.workers),
                            function(worker) {
                              return worker.process.pid;
                            });
        assert.equal(_.intersection(oldPids, newPids).length, 0);

        master.on('shutdownDone', function() {
          assert.equal(_.keys(cluster.workers).length, 0);
          done();
        });
        master.shutdown();
      }, 6000);
  }, 1000);
  });
});
