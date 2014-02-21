var _ = require('underscore');
var cluster = require('cluster');
var dive = require('dive');
var fs = require('fs');
var EventEmitter = require('events').EventEmitter;

var master = new EventEmitter;
module.exports = master;

var settings = {
  "reloadDelay": 5000,
  "disconnectTimeout": 2000,
  "startupTimeout": 5000,
  "workers": 2,
  "parallelReloads": 1,
  "watchFiles": [],
  "watchCallback": function(event, file) {
    console.log('Got change in %s', file);
    stopWatchingFiles();
    master.reload();
  }
};

var startupInProgress = false;
var reloadInProgress = false;
var reloadWaiting = false;
var reloadPending = false;
var shuttingDown = false;
var shutdownPending = false;
var running = false;

var workersToKill = {};
var workersBeingKilled = {};
var workersStartingUp = {};

var fileWatchers = [];

master.isMaster = cluster.isMaster;
master.startupInProgress = function() { return startupInProgress; };
master.reloadInProgress = function() { return reloadInProgress; };
master.reloadWaiting = function() { return reloadWaiting; };
master.reloadPending = function() { return reloadPending; };
master.shuttingDown = function() { return shuttingDown; };
master.running = function() { return running; };
master.reload = function() {
  if(!this.isMaster)
    throw new Error('This is only to be called from master process');
  reload();
};
master.shutdown = function() {
  if(!this.isMaster)
    throw new Error('This is only to be called from master process');
  shutdown();
};
master.run = function(newSettings) {
  if(!this.isMaster)
    throw new Error('This is only to be called from master process');

  if(running) {
    throw new Error("Already running, cannot start");
  }

  if(shuttingDown || shutdownPending) {
    throw new Error("Shutdown is pending or in progress, cannot start");
  }

  if(newSettings) {
    settings = _.extend(settings, newSettings);
  }

  if(!_.isArray(settings.watchFiles)) settings.watchFiles = [settings.watchFiles];
  if(settings.watchFiles.length) this.on('reload', startWatchingFiles);

  running = true;

  cluster.on('exit', onWorkerExit);
  cluster.on('listening', onWorkerListening);

  startupInProgress = true;
  this.emit('reload');

  for (var i = 0; i < settings.workers; i++)
    startWorker();
};

function reload() {
  if(reloadWaiting) return;
  if(!running) {
    throw new Error("Not running, cannot reload");
  }
  if(shuttingDown || shutdownPending) {
    console.log("Shutdown is pending or in progress, won't reload");
    return;
  }
  if(reloadInProgress || startupInProgress) {
    reloadPending = true;
    return;
  }
  reloadInProgress = true;
  reloadWaiting = true;

  console.log('Scheduling workers reload');
  setTimeout(function() {
    reloadWaiting = false;
    for (var id in cluster.workers) {
      workersToKill[id] = cluster.workers[id];
    }
    master.emit('reload');
    batchReload();
  }, settings.reloadDelay);
}

function shutdown() {
  if(shuttingDown) return;
  if(!running) {
    throw new Error("Not running, cannot shutdown");
  }
  if(reloadInProgress || startupInProgress) {
    shutdownPending = true;
    return;
  }

  shuttingDown = true;
  console.log('Shutting down workers');

  stopWatchingFiles();

  _.values(cluster.workers).forEach(function(worker) {
    worker.disconnect();
    workersBeingKilled[worker.id] = {
      worker: worker,
      timeout: setTimeout(function() {
        console.error('Worker was dying too slowly, killing it: %d', worker.process.pid);
        worker.kill();
      }, settings.disconnectTimeout)
    };
  });
};

function onWorkerExit(worker, code, signal) {
  if(workersBeingKilled[worker.id]) {
    console.log('Worker %d exited (%d), we were expecting that',
                worker.process.pid, signal || code);
    clearTimeout(workersBeingKilled[worker.id].timeout);
    delete workersBeingKilled[worker.id];
    checkStatus();
    return;
  }

  if(workersToKill[worker.id]) {
    console.log('Worker exited (%d), we were not expecting that, but we were going to kill it'
                + ' later anyway', worker.process.pid, signal || code);
    //Note: we do not need to remove worker from workersToKill here - we use it as a list to
    //start up new workers, we just make sure that we do not disconnect non existant worker
    return;
  }

  if(workersStartingUp[worker.id]) {
    console.error('Worker exited (%d), we were not expecting that, it was just starting up',
                worker.process.pid, signal || code);
    var workerData = workersStartingUp[worker.id];
    delete workersStartingUp[worker.id];
    clearTimeout(workerData.timeout);
    startWorker(workerData.oldWorker);
    return;
  }

  console.error('Worker %d died (%s) unexpectedly, restarting...', worker.process.pid, signal || code);
  startWorker();
};

function onWorkerListening(worker, address) {
  console.log('Worker %d is listenting (%s:%d)', worker.process.pid,
              address.address, address.port);
  var workerData = workersStartingUp[worker.id];
  delete workersStartingUp[worker.id];
  clearTimeout(workerData.timeout);
  if(workerData.oldWorker) {
    var oldWorker = workerData.oldWorker;
    if(cluster.workers[oldWorker.id]) {
      oldWorker.disconnect();
      workersBeingKilled[oldWorker.id] = {
        "worker": oldWorker,
        "timeout": setTimeout(function() {
          console.error('Old worker was dying too slowly, killing it: %d', oldWorker.process.pid);
          oldWorker.kill();
        }, settings.disconnectTimeout)
      };
    } else {
      console.log('Old worker has exited before we had a chance to kill it',
                  oldWorker.process.pid);
    }
  }
  batchReload();
}

function startWorker(oldWorker) {
  var newWorker = cluster.fork();
  console.log('Created new worker: %d', newWorker.process.pid);
  workersStartingUp[newWorker.id] = {
    "oldWorker": oldWorker,
    "newWorker": newWorker,
    "timeout": setTimeout(function() {
      console.error('Timeout waiting for new worker to start up: %d', newWorker.process.pid);
      //Note: this must trigger automatic restart attempt
      newWorker.kill();
    }, settings.startupTimeout)
  };
};

function checkStatus() {
  //Note: the first check might be triggered when we just reload worker that died off
  //It is important that we actually verify state inside this if.
  if(_.keys(workersStartingUp).length === 0 && _.keys(workersBeingKilled).length === 0) {
    if(shuttingDown) {
      shuttingDown = false;
      running = false;
      console.log('Shutdown is done');
      master.emit('shutdownDone');
      return;
    }
    if(shutdownPending) {
      console.log('Shutdown is pending, sheduling shutdown');
      shutdownPending = false;
      shutdown();
      return;
    };
    if(reloadInProgress) {
      reloadInProgress = false;
      console.log('Reload is done');
      master.emit('reloadDone');
    }
    if(startupInProgress) {
      startupInProgress = false;
      console.log('Startup is done');
      master.emit('startupDone');
    }
    if(reloadPending) {
      console.log('Reload is pending, sheduling new reload');
      reloadPending = false;
      reload();
    }
  }
}

function batchReload() {
  var newWorkers = settings.parallelReloads - _.keys(workersStartingUp).length;
  var i = 0;
  while(i < newWorkers && _.keys(workersToKill).length) {
    var oldWorkerId = _.keys(workersToKill).pop();
    var oldWorker = workersToKill[oldWorkerId];
    delete workersToKill[oldWorkerId];
    startWorker(oldWorker);
    i++;
  }
  checkStatus();
}

function startWatchingFiles() {
  settings.watchFiles.forEach(function(dir) {
    console.log('Watching for changes: %s', dir);
    fileWatchers.push(fs.watch(dir, settings.watchCallback));
    fs.stat(dir, function(err, stats) {
      if(err) {
        console.error('Error retrieving stats for file: %s', dir);
        return;
      }
      if(stats.isDirectory()) {
        dive(dir, { directories: true }, function(err, file) {
          if(err) {
            console.error("Error diving into '%s' for watching: %s", dir, err);
            return;
          }
          console.log('Watching for changes: %s', file);
          fileWatchers.push(fs.watch(file, settings.watchCallback));
        });
      }
    });
  });
}

function stopWatchingFiles() {
  console.log('Stop watching files');
  for (var i in fileWatchers) {
    fileWatchers[i].close();
  }
  fileWatchers = [];
}
