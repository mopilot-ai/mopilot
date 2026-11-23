// The remote terminal methods: open a shell in a followed chat's folder, write to it, resize it and close it.
module.exports = {
  'pty.open': (svc, client, p) => svc.mirror.pty.open(client, p),
  'pty.write': (svc, client, p) => svc.mirror.pty.write(client, p),
  'pty.resize': (svc, client, p) => svc.mirror.pty.resize(client, p),
  'pty.close': (svc, client, p) => svc.mirror.pty.close(client, p),
};
