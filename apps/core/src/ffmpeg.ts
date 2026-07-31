/**
 * ffmpeg discovery, capability probing, and process helpers.
 *
 * The important idea here: capability lists lie. `ffmpeg -encoders` cheerfully
 * lists `h264_nvenc` on a machine where NVENC cannot actually open, because
 * ffmpeg's required NVENC API version outruns the installed NVIDIA driver.
 * We hit exactly that (needs driver 610.00+, had 596.49). So `probeEncoder`
 * runs a real one-frame encode and believes the result, not the list.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

export interface FfmpegTools { ffmpeg: string; ffprobe: string }

const exe = (name: string): string => process.platform === 'win32' ? `${name}.exe` : name;

async function isExecutable(p: string): Promise<boolean> {
  try { await access(p, constants.X_OK); return true; } catch { return false; }
}

/**
 * Look on PATH first, then in winget's package directory: winget updates PATH
 * for *new* shells only, so a freshly-installed ffmpeg is invisible to a
 * long-running server until it restarts. Finding it anyway avoids a confusing
 * "not installed" error right after installing it.
 */
export async function findFfmpeg(explicitDir?: string): Promise<FfmpegTools | null> {
  const candidates: string[] = [];
  if (explicitDir) candidates.push(explicitDir);

  for (const dir of (process.env['PATH'] ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (dir) candidates.push(dir);
  }

  const local = process.env['LOCALAPPDATA'];
  if (local) {
    const pkgRoot = join(local, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const entry of await readdir(pkgRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('Gyan.FFmpeg')) continue;
        const inner = join(pkgRoot, entry.name);
        for (const build of await readdir(inner, { withFileTypes: true })) {
          if (build.isDirectory()) candidates.push(join(inner, build.name, 'bin'));
        }
      }
      candidates.push(join(local, 'Microsoft', 'WinGet', 'Links'));
    } catch { /* no winget packages, fine */ }
  }

  for (const dir of candidates) {
    const ffmpeg = join(dir, exe('ffmpeg'));
    if (await isExecutable(ffmpeg)) {
      const ffprobe = join(dir, exe('ffprobe'));
      return { ffmpeg, ffprobe: (await isExecutable(ffprobe)) ? ffprobe : exe('ffprobe') };
    }
  }
  return null;
}

export interface RunResult { code: number | null; stdout: string; stderr: string }

export function run(bin: string, args: string[], timeoutMs = 60_000): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => { clearTimeout(timer); resolve({ code: null, stdout, stderr: String(err) }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/**
 * Actually encode two frames with the named encoder. Returns null on success,
 * or the reason it failed, which is worth surfacing verbatim, because
 * "Driver does not support the required nvenc API version" tells an operator
 * exactly what to do and "encoder unavailable" does not.
 */
export async function probeEncoder(ffmpeg: string, encoder: string): Promise<string | null> {
  const { code, stderr } = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-frames:v', '2', '-c:v', encoder, '-f', 'null', '-',
  ], 30_000);

  if (code === 0) return null;
  const line = stderr.split('\n').map(s => s.trim())
    .find(s => s && !s.startsWith('Conversion failed')) ?? `exit ${code}`;
  return line;
}

export type EncoderChoice = { encoder: string; args: string[]; reason: string };

/**
 * Pick the best working video encoder. Order matters: hardware first because
 * CPU encoding four 1080p60 angles is not feasible (measured 2.88x realtime
 * for ONE stream with libx264 veryfast), then a CPU fallback that always works.
 */
export async function chooseEncoder(ffmpeg: string, preferred?: string): Promise<EncoderChoice> {
  const candidates: EncoderChoice[] = [
    { encoder: 'h264_nvenc', args: ['-preset', 'p1', '-tune', 'll'], reason: 'NVIDIA NVENC' },
    { encoder: 'h264_qsv', args: ['-preset', 'veryfast'], reason: 'Intel Quick Sync' },
    { encoder: 'h264_amf', args: ['-quality', 'speed'], reason: 'AMD AMF' },
    { encoder: 'libx264', args: ['-preset', 'veryfast', '-tune', 'zerolatency'], reason: 'CPU (libx264)' },
  ];

  const ordered = preferred
    ? [...candidates.filter(c => c.encoder === preferred), ...candidates.filter(c => c.encoder !== preferred)]
    : candidates;

  for (const c of ordered) {
    const failure = await probeEncoder(ffmpeg, c.encoder);
    if (!failure) {
      console.log(`[ffmpeg] encoder: ${c.encoder} (${c.reason})`);
      return c;
    }
    console.warn(`[ffmpeg] ${c.encoder} unavailable: ${failure}`);
  }

  // Nothing worked, which shouldn't happen since libx264 is in every build.
  return { encoder: 'libx264', args: ['-preset', 'veryfast'], reason: 'CPU (forced fallback)' };
}

/** Media duration in seconds, or null if the file is unreadable/still being written. */
export async function duration(ffprobe: string, file: string): Promise<number | null> {
  const { code, stdout } = await run(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ], 15_000);
  if (code !== 0) return null;
  const n = Number(stdout.trim());
  return Number.isFinite(n) ? n : null;
}

export const spawnDetached = (bin: string, args: string[]): ChildProcess =>
  spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
