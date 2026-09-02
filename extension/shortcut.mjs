// What the "Career-Ops Companion" shortcut should point at.
//
// Two targets are possible and the difference is felt every single launch:
//
//   fast    chrome.exe directly, with the same arguments dev-launch would have
//           spawned. No console window, no Node, no server round-trip — the
//           browser is simply up.
//   setup   cmd.exe -> companion.cmd -> extension/setup-companion.mjs --launch. Two Node
//           starts, two server pre-flights and a PowerShell call, behind a
//           console window that flashes past. It is the right target only
//           while something still has to be set up.
//
// The fast target is safe exactly when the extension is already loaded in the
// profile and the config file it reads (extension/companion.local.json) is
// current, because then a launch has nothing left to do. `findExtension()`
// and `bundledConfigCurrent()` answer both, so this module never has to guess
// — see extension/launch.mjs.
//
// Everything here is pure: it decides and renders, it does not write. Guarded
// by tests/companion-shortcut.test.mjs.
import path from 'node:path';
import { launchArgs } from './launch.mjs';

/**
 * Chrome's per-profile taskbar identity.
 *
 * Chrome derives an AppUserModelID from the user-data-dir and profile
 * directory (`ShellUtil::GetAppModelIdForProfile`), which is why the companion
 * already gets its own taskbar button instead of merging into the candidate's
 * everyday Chrome. Observed on this fleet:
 *
 *   --user-data-dir=…\.companion-profile-chrome  ->  Chrome..companionprofilechrome.Default
 *
 * A pinned shortcut only merges with that window if the shortcut carries the
 * same id, so it has to be reproduced rather than read — Chrome computes it at
 * runtime and persists it nowhere. The sanitiser keeps letters, digits and
 * dots and drops everything else, which is why the leading dot survives and
 * the hyphens do not.
 *
 * Only correct for a default-location branded Chrome install; a relocated one
 * carries a hash in the base id. Callers pass `baseAppId: null` to mean "do
 * not claim to know", and the shortcut is then written without an id — it
 * still launches, it just may pin as a second button.
 *
 * @param {{userDataDir: string, profileDirName?: string, baseAppId?: string}} opts
 * @returns {string|null}
 */
export function chromeAppId({ userDataDir, profileDirName = 'Default', baseAppId = 'Chrome' }) {
  if (!baseAppId || !userDataDir) return null;
  const clean = (s) => String(s).replace(/[^A-Za-z0-9.]/g, '');
  return `${baseAppId}.${clean(path.basename(userDataDir))}.${clean(profileDirName)}`;
}

/**
 * Quote one launch argument for a shortcut's Arguments string.
 *
 * `--flag=C:\some path\x` has to become `--flag="C:\some path\x"`: the value is
 * quoted, the flag name is not. Backslashes stay literal — this is a Windows
 * command line, not a C string, so escaping them (JSON.stringify's instinct)
 * produces a path Chrome cannot open.
 *
 * @param {string} arg
 * @returns {string}
 */
export function quoteArg(arg) {
  const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
  if (eq > 0) {
    const value = arg.slice(eq + 1);
    return /\s/.test(value) ? `${arg.slice(0, eq + 1)}"${value}"` : arg;
  }
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

/**
 * Decide what the shortcut should launch.
 *
 * @param {{browser: string|null, repo: string, profileDir: string, startUrl: string,
 *          icon: string, ready: boolean, baseAppId?: string}} opts
 * @returns {{kind: string, target: string, args: string, workingDirectory: string,
 *            icon: string, appId: string|null, description: string, why: string}}
 */
export function shortcutSpec({
  browser, repo, profileDir, startUrl, icon, ready, baseAppId = 'Chrome',
}) {
  const setup = {
    kind: 'setup',
    // cmd.exe rather than the .cmd file: Windows will not pin a
    // shortcut-to-batch-file to the taskbar, but it pins this happily.
    target: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
    args: `/c ""${path.join(repo, 'companion.cmd')}""`,
    workingDirectory: repo,
    icon,
    appId: null,
    description: 'Set up and launch the Career-Ops Companion browser',
    why: ready
      ? 'the fast target needs a browser this launcher can spawn directly'
      : 'the extension is not loaded in the profile yet, so a launch still has work to do',
  };
  if (!ready || !browser) return setup;

  const args = launchArgs({ profileDir, startUrl }).map(quoteArg).join(' ');
  return {
    kind: 'fast',
    target: browser,
    args,
    workingDirectory: repo,
    icon,
    appId: chromeAppId({ userDataDir: profileDir, baseAppId }),
    description: 'Career-Ops Companion — the browser your applications are filled in',
    why: 'the extension is loaded and its config file is current, so there is nothing to do but open the browser',
  };
}

/**
 * PowerShell that writes one shortcut and, when there is an id, stamps it.
 *
 * WScript.Shell cannot set System.AppUserModel.ID — that needs IShellLink's
 * IPropertyStore — so the id is applied in a second step against the file the
 * first step just wrote. The .lnk survives it intact.
 *
 * @param {{spec: object, paths: string[]}} opts
 * @returns {string}
 */
export function shortcutScript({ spec, paths }) {
  const ps = (s) => String(s).replace(/'/g, "''");
  const write = paths.map((target) => `
$sc = $ws.CreateShortcut('${ps(target)}')
$sc.TargetPath = '${ps(spec.target)}'
$sc.Arguments = '${ps(spec.args)}'
$sc.WorkingDirectory = '${ps(spec.workingDirectory)}'
$sc.IconLocation = '${ps(spec.icon)},0'
$sc.Description = '${ps(spec.description)}'
$sc.WindowStyle = 1
$sc.Save()
Write-Output 'wrote ${ps(target)}'`).join('\n');

  const stamp = spec.appId ? `
Add-Type -Language CSharp -TypeDefinition @'
${APPID_SHIM}
'@
foreach ($p in @(${paths.map((t) => `'${ps(t)}'`).join(', ')})) {
  try { [LnkAppId]::Set($p, '${ps(spec.appId)}'); Write-Output ('stamped ' + $p) }
  catch { Write-Output ('could not stamp ' + $p + ': ' + $_.Exception.Message) }
}` : '';

  return `$ErrorActionPreference = 'Stop'
$ws = New-Object -ComObject WScript.Shell
${write}
${stamp}
`;
}

// Minimal IShellLink + IPropertyStore shim. Inlined rather than shipped as a
// .ps1 so the shortcut step stays a single PowerShell invocation with nothing
// left on disk afterwards.
const APPID_SHIM = `using System;
using System.Runtime.InteropServices;

public static class LnkAppId {
    [StructLayout(LayoutKind.Sequential)] public struct PROPERTYKEY { public Guid fmtid; public uint pid; }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
        int GetCount(out uint c);
        int GetAt(uint i, out PROPERTYKEY k);
        int GetValue(ref PROPERTYKEY k, [In, Out] PropVariant v);
        int SetValue(ref PROPERTYKEY k, PropVariant v);
        int Commit();
    }

    [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPersistFile {
        void GetClassID(out Guid c);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string f, uint mode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string f, [MarshalAs(UnmanagedType.Bool)] bool remember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string f);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string f);
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class ShellLink { }

    [StructLayout(LayoutKind.Sequential)]
    public class PropVariant : IDisposable {
        ushort vt; ushort r1; ushort r2; ushort r3; IntPtr p; int p2;
        public PropVariant() { }
        public PropVariant(string value) { vt = 31; p = Marshal.StringToCoTaskMemUni(value); }
        public string AsString() { return vt == 31 ? Marshal.PtrToStringUni(p) : null; }
        [DllImport("ole32.dll")] static extern int PropVariantClear([In, Out] PropVariant pv);
        public void Dispose() { PropVariantClear(this); }
    }

    static PROPERTYKEY Key() {
        PROPERTYKEY k = new PROPERTYKEY();
        k.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
        k.pid = 5;
        return k;
    }

    public static void Set(string linkPath, string appId) {
        object o = new ShellLink();
        ((IPersistFile)o).Load(linkPath, 2);
        IPropertyStore ps = (IPropertyStore)o;
        PROPERTYKEY k = Key();
        using (PropVariant v = new PropVariant(appId)) {
            Marshal.ThrowExceptionForHR(ps.SetValue(ref k, v));
            Marshal.ThrowExceptionForHR(ps.Commit());
        }
        ((IPersistFile)o).Save(linkPath, true);
        Marshal.ReleaseComObject(o);
    }

    public static string Get(string linkPath) {
        object o = new ShellLink();
        ((IPersistFile)o).Load(linkPath, 0);
        IPropertyStore ps = (IPropertyStore)o;
        PROPERTYKEY k = Key();
        using (PropVariant v = new PropVariant()) {
            if (ps.GetValue(ref k, v) != 0) return null;
            return v.AsString();
        }
    }
}`;

/** Where Windows keeps the taskbar's pinned shortcuts. */
export function taskbarPinDir() {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  return path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
}
