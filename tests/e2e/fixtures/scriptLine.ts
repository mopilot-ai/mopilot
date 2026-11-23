// A setup or cleanup script line that writes a command's output to a file as plain text in the shell that runs it.

/**
 * `command > file` on macOS and Linux. On Windows the app runs environment scripts in Windows PowerShell 5.1, whose `>`
 * writes UTF-16 with a byte-order mark, so the line pipes to `Out-File -Encoding ascii` there instead.
 */
export function writeTo(command: string, file: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${command} | Out-File -Encoding ascii ${file}` : `${command} > ${file}`;
}
