// The remote frame methods: watch a followed chat's browser page or screen while one of its tools runs.
module.exports = {
  'frames.subscribe': (svc, client, p) => svc.mirror.frames.subscribe(client, p),
  'frames.unsubscribe': (svc, client, p) => svc.mirror.frames.unsubscribe(client, p),
};
