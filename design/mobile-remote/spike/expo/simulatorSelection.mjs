// Pick an available iOS runtime and an iPhone type already represented on that runtime; the test creates its own device.
/** @param {{identifier:string,isAvailable:boolean}[]} runtimes @param {{identifier:string,name:string}[]} types @param {Record<string, {name:string,isAvailable:boolean,deviceTypeIdentifier?:string}[]>} devices */
export function selectSimulator(runtimes, types, devices) {
  for (const runtime of runtimes) {
    if (!runtime.isAvailable || !runtime.identifier.includes('SimRuntime.iOS')) continue;
    for (const device of devices[runtime.identifier] ?? []) {
      if (!device.isAvailable || !device.name.startsWith('iPhone')) continue;
      const type = types.find((t) => device.deviceTypeIdentifier ? t.identifier === device.deviceTypeIdentifier : t.name === device.name);
      if (type) return { runtime: runtime.identifier, device: type.identifier };
    }
  }
  throw new Error('no available iPhone device type mapped to an available iOS runtime');
}
