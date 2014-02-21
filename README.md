yacm
=========

Yet another cluster master (yacm). Simple worker manager with rolling reload and file watchers

## Synopsis

### Setup
```javascript
  var master = require('yacm');
  if(master.isMaster) {
    var files = [file_to_watch1, file_to_watch2];
    master.run({watchFiles: files});
  } else {
    //Your normal worker code here
    run();
  }
};
```

## API

### Starting up

```javascript
master.run(options);
```

Sets some options and starts up workers.

###Shutting down

```javascript
master.shutdown();
```

Stops all workers.

Note: workers are stopped automatically when process exists, so you probably do not need to call this.

### Reloading workers

```javascript
master.reload();
```

This will schedule reload of workers. Reload happens in rolling manner and there are some configuration options you might want to tune, see below.

This function is clever enough to schedule single reload after multiple calls. It also schedules pending reload if one is already running.

###Configuration options

Some additional configuration options can be passed to master.run():

* "reloadDelay": A grace perion in ms to wait after master.reload had been called before actually starting reload. Default: 5000.
* "disconnectTimeout": A timeout to wait for worker to disconnect. Worker will be killed if it doesn't disconnect by then. Default: 2000.
* "startupTimeout": A timeout to wait for new worker to start listening. Worker will be killed and restarted if it doesn't start listening by then. Default: 5000.
* "workers": Number of workers to keep running. Default: 2/
* "parallelReloads": Number of workers to be concurrently reloading. During reload process up to this number of workers will be started up while old workers dying off. Default: 1.
* "watchFiles": Arrays of file paths to watch. Default: [].
* "watchCallback": A callback to call when whatched file changed. Default: some reasonable code to reload everything.

### Events

This module emits the following events (see [EventEmitter](http://nodejs.org/api/events.html) for details):

* 'reload': this event is emited just before reload process is started (after "reloaDelay" has been waited). This is the right time to start whatever changes whatching process you might have.

* 'shutdownDone': the shutdown had been completed.

* 'reloadDone': the reload had been completed.

* 'startupDone': the startup had been completed.