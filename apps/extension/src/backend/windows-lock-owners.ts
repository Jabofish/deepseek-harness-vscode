import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface WindowsLockOwner {
  readonly pid: number
  readonly name: string
}

// Restart Manager reports file users, not directory users. Register a bounded
// set of files; prioritise native modules while retaining ordinary-file locks.
// https://learn.microsoft.com/windows/win32/api/restartmanager/nf-restartmanager-rmgetlist
const queryScript = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class DshLockOwners {
  [StructLayout(LayoutKind.Sequential)]
  public struct UniqueProcess { public int Id; public System.Runtime.InteropServices.ComTypes.FILETIME Started; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct ProcessInfo {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string App;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string Service;
    public uint Type, Status, Session;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  public sealed class Owner { public int pid; public string name; }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  static extern int RmStartSession(out uint session, uint flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  static extern int RmRegisterResources(uint session, uint count, string[] files, uint apps, IntPtr processes, uint services, IntPtr names);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] ProcessInfo[] info, ref uint reasons);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
  public static Owner[] Query(string[] files) {
    uint session;
    if (RmStartSession(out session, 0, new StringBuilder(33)) != 0) return new Owner[0];
    try {
      if (RmRegisterResources(session, (uint)files.Length, files, 0, IntPtr.Zero, 0, IntPtr.Zero) != 0) return new Owner[0];
      uint count=0, needed=0, reasons=0;
      ProcessInfo[] info=null;
      for (int attempt=0; attempt<3; attempt++) {
        int result=RmGetList(session, out needed, ref count, info, ref reasons);
        if (result==234) { if (needed>256) return new Owner[0]; count=needed; info=new ProcessInfo[count]; continue; }
        if (result!=0) return new Owner[0];
        var owners=new List<Owner>();
        for (int i=0; i<count; i++) {
          try {
            using (var process=Process.GetProcessById(info[i].Process.Id)) {
              long started=((long)(uint)info[i].Process.Started.dwHighDateTime<<32)|(uint)info[i].Process.Started.dwLowDateTime;
              if (process.StartTime.ToUniversalTime().ToFileTimeUtc()!=started) continue;
              owners.Add(new Owner { pid=process.Id, name=process.ProcessName });
            }
          } catch (ArgumentException) {} catch (System.ComponentModel.Win32Exception) {} catch (InvalidOperationException) {}
        }
        return owners.ToArray();
      }
      return new Owner[0];
    } finally { RmEndSession(session); }
  }
}
'@
$files = [string[]](ConvertFrom-Json ([Console]::In.ReadToEnd()))
[Console]::Out.WriteLine('DSH_LOCK_QUERY_READY')
[Console]::Out.Flush()
$owners = @([DshLockOwners]::Query($files))
ConvertTo-Json -InputObject $owners -Compress
`

/** Diagnostics only: Restart Manager never gains authority to stop external processes. */
export async function findWindowsLockOwners(
  targets: readonly string[],
): Promise<readonly WindowsLockOwner[]> {
  if (process.platform !== 'win32') return []
  try {
    const files = await collectFiles(targets)
    if (files.length === 0) return []
    return await new Promise((resolve) => {
      const child = spawn(
        path.join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        ['-NoProfile', '-NonInteractive', '-Command', queryScript],
        { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
      )
      let output = ''
      let settled = false
      let queryStarted = false
      const finish = (owners: readonly WindowsLockOwner[]): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.stdin.destroy()
        child.stdout.destroy()
        resolve(owners)
      }
      const timeout = (): void => {
        child.kill()
        finish([])
      }
      // PowerShell startup and Add-Type compilation can exceed the query budget
      // under load. Allow 15s to initialise, then at most 5s for Restart Manager.
      let timer = setTimeout(timeout, 15_000)
      child.once('error', () => finish([]))
      child.stdin.on('error', () => undefined)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (settled) return
        output = (output + chunk).slice(-32_768)
        if (!queryStarted) {
          const newline = output.indexOf('\n')
          if (newline >= 0 && output.slice(0, newline).trim() === 'DSH_LOCK_QUERY_READY') {
            queryStarted = true
            output = output.slice(newline + 1)
            clearTimeout(timer)
            timer = setTimeout(timeout, 5_000)
          }
        }
      })
      child.once('close', () => {
        try {
          const owners: unknown = JSON.parse(output)
          finish(
            Array.isArray(owners)
              ? owners
                  .filter(
                    (owner: unknown): owner is WindowsLockOwner =>
                      typeof owner === 'object' &&
                      owner !== null &&
                      'pid' in owner &&
                      Number.isSafeInteger(owner.pid) &&
                      Number(owner.pid) > 0 &&
                      'name' in owner &&
                      typeof owner.name === 'string' &&
                      /^[\p{L}\p{N}_. -]{1,100}$/u.test(owner.name),
                  )
                  .slice(0, 16)
              : [],
          )
        } catch {
          finish([])
        }
      })
      // Paths travel as data over stdin, never interpolated into PowerShell code.
      child.stdin.end(JSON.stringify(files), 'utf8')
    })
  } catch {
    return []
  }
}

async function collectFiles(targets: readonly string[]): Promise<readonly string[]> {
  const pending = [...targets]
  const ordinary: string[] = []
  const native: string[] = []
  let scanned = 0
  const deadline = Date.now() + 500
  while (pending.length > 0 && scanned < 40_000 && Date.now() < deadline) {
    const target = pending.shift()
    if (target === undefined) break
    const stat = await fs.lstat(target).catch(() => undefined)
    if (stat?.isSymbolicLink() === true || stat === undefined) continue
    if (stat.isFile()) {
      ordinary.push(target)
      continue
    }
    if (!stat.isDirectory()) continue
    for (const entry of await fs.readdir(target, { withFileTypes: true })) {
      scanned++
      const file = path.join(target, entry.name)
      if (entry.isDirectory()) pending.push(file)
      else if (entry.isFile()) {
        if (/\.(?:node|dll|exe)$/iu.test(entry.name)) native.push(file)
        else if (ordinary.length < 4096) ordinary.push(file)
      }
    }
  }
  return [...native, ...ordinary].slice(0, 4096)
}
