import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';

// Ленивая инициализация ffmpeg (только при необходимости)
let ffmpegPath: string | null = null;
let ffmpegInitialized = false;
let ffprobePath: string | null = null;

function searchForExecutable(baseDir: string, fileName: string, maxDepth = 5, depth = 0): string[] {
  try {
    const stats = fs.statSync(baseDir);
    if (!stats.isDirectory() || depth > maxDepth) {
      return [];
    }
  } catch {
    return [];
  }

  const results: string[] = [];

  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(baseDir, entry.name);
      if (entry.isFile() && entry.name === fileName) {
        results.push(entryPath);
      } else if (entry.isDirectory()) {
        // Пропускаем слишком глубокие node_modules, чтобы не зациклиться
        if (entry.name === 'node_modules' && depth >= maxDepth) {
          continue;
        }
        results.push(...searchForExecutable(entryPath, fileName, maxDepth, depth + 1));
      }
    }
  } catch {
    // Игнорируем ошибки доступа
  }

  return results;
}

function findNodeModulesRoot(): string {
  // Пробуем найти корень node_modules
  let currentDir = process.cwd();
  
  // В Next.js process.cwd() может быть apps/web, нужно подняться выше
  for (let i = 0; i < 5; i++) {
    const nodeModulesPath = path.join(currentDir, 'node_modules');
    if (fs.existsSync(nodeModulesPath)) {
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break; // Достигли корня файловой системы
    }
    currentDir = parentDir;
  }
  
  return process.cwd();
}

function initializeFfmpeg(): void {
  if (ffmpegInitialized) return;
  
  try {
    ffprobePath = null;
    // Пробуем найти ffmpeg в нескольких местах
    const pathsToTry: string[] = [];
    
    // 1. Через @ffmpeg-installer/ffmpeg (самый надежный способ)
    try {
      const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
      if (ffmpegInstaller && ffmpegInstaller.path) {
        const installerPath = ffmpegInstaller.path;
        // Проверяем, что путь существует
        if (fs.existsSync(installerPath)) {
          pathsToTry.push(installerPath);
        }
        const installerDir = path.dirname(installerPath);
        const bundledFfprobe = path.join(installerDir, 'ffprobe');
        if (fs.existsSync(bundledFfprobe)) {
          ffprobePath = bundledFfprobe;
        }
      }
    } catch (e: any) {
      // Игнорируем ошибку require, будем искать вручную
    }

    // 2. Поиск в pnpm структуре (динамический поиск всех версий)
    const nodeModulesRoot = findNodeModulesRoot();
    
    // Пробуем найти все возможные пути в .pnpm
    try {
      const pnpmDir = path.join(nodeModulesRoot, '.pnpm');
      if (fs.existsSync(pnpmDir)) {
        // Ищем все директории, начинающиеся с @ffmpeg-installer
        const entries = fs.readdirSync(pnpmDir);
        for (const entry of entries) {
          if (entry.startsWith('@ffmpeg-installer')) {
            const possiblePaths = [
              path.join(pnpmDir, entry, 'node_modules', '@ffmpeg-installer', 'darwin-arm64', 'ffmpeg'),
              path.join(pnpmDir, entry, 'node_modules', '@ffmpeg-installer', 'darwin-x64', 'ffmpeg'),
              path.join(pnpmDir, entry, 'node_modules', '@ffmpeg-installer', 'ffmpeg', 'darwin-arm64', 'ffmpeg'),
              path.join(pnpmDir, entry, 'node_modules', '@ffmpeg-installer', 'ffmpeg', 'darwin-x64', 'ffmpeg'),
            ];
            pathsToTry.push(...possiblePaths);
          }
        }
      }
    } catch (e: any) {
      // Игнорируем ошибки чтения директории
    }
    
    // 3. Стандартные пути в node_modules
    const standardPaths = [
      path.join(nodeModulesRoot, 'node_modules', '@ffmpeg-installer', 'ffmpeg', 'darwin-arm64', 'ffmpeg'),
      path.join(nodeModulesRoot, 'node_modules', '@ffmpeg-installer', 'ffmpeg', 'darwin-x64', 'ffmpeg'),
      path.join(nodeModulesRoot, 'node_modules', '@ffmpeg-installer', 'darwin-arm64', 'ffmpeg'),
      path.join(nodeModulesRoot, 'node_modules', '@ffmpeg-installer', 'darwin-x64', 'ffmpeg'),
    ];
    pathsToTry.push(...standardPaths);
    
    // 4. В node_modules (для monorepo - относительные пути от process.cwd())
    const cwdPaths = [
      path.join(process.cwd(), 'node_modules', '@ffmpeg-installer', 'ffmpeg', 'darwin-arm64', 'ffmpeg'),
      path.join(process.cwd(), 'node_modules', '@ffmpeg-installer', 'ffmpeg', 'darwin-x64', 'ffmpeg'),
      path.join(process.cwd(), '..', '..', 'node_modules', '@ffmpeg-installer', 'ffmpeg', 'darwin-arm64', 'ffmpeg'),
      path.join(process.cwd(), '..', '..', 'node_modules', '@ffmpeg-installer', 'ffmpeg', 'darwin-x64', 'ffmpeg'),
      path.join(process.cwd(), '..', 'node_modules', '@ffmpeg-installer', 'ffmpeg', 'darwin-arm64', 'ffmpeg'),
    ];
    pathsToTry.push(...cwdPaths);
    
    // 5. Системный ffmpeg (если установлен)
    pathsToTry.push('/usr/local/bin/ffmpeg');
    pathsToTry.push('/opt/homebrew/bin/ffmpeg');
    pathsToTry.push('/usr/bin/ffmpeg');

    // 6. Рекурсивный поиск в .pnpm и node_modules (на случай отличающихся структур)
    const pnpmSearchRoots = [
      path.join(nodeModulesRoot, '.pnpm'),
      path.join(process.cwd(), '.pnpm'),
      path.join(process.cwd(), '..', '.pnpm'),
      path.join(process.cwd(), '..', '..', '.pnpm'),
    ];

    const foundFfprobes: string[] = [];

    for (const searchRoot of pnpmSearchRoots) {
      const found = searchForExecutable(searchRoot, 'ffmpeg', 6);
      pathsToTry.push(...found);
      const foundProbe = searchForExecutable(searchRoot, 'ffprobe', 6);
      foundFfprobes.push(...foundProbe);
    }

    const nodeModulesSearchRoots = [
      path.join(nodeModulesRoot, 'node_modules'),
      path.join(process.cwd(), 'node_modules'),
      path.join(process.cwd(), '..', 'node_modules'),
      path.join(process.cwd(), '..', '..', 'node_modules'),
    ];

    for (const searchRoot of nodeModulesSearchRoots) {
      const found = searchForExecutable(searchRoot, 'ffmpeg', 6);
      pathsToTry.push(...found);
      const foundProbe = searchForExecutable(searchRoot, 'ffprobe', 6);
      foundFfprobes.push(...foundProbe);
    }

    const uniqueProbes = Array.from(new Set(foundFfprobes));
    if (!ffprobePath && uniqueProbes.length > 0) {
      ffprobePath = uniqueProbes[0];
    }

    // Пробуем каждый путь
    for (const testPath of pathsToTry) {
      try {
        if (fs.existsSync(testPath)) {
          // Проверяем, что это исполняемый файл
          const stats = fs.statSync(testPath);
          if (stats.isFile()) {
            ffmpegPath = testPath;
            ffmpeg.setFfmpegPath(testPath);
            console.log('✅ FFmpeg found at:', testPath);
            if (ffprobePath) {
              try {
                ffmpeg.setFfprobePath(ffprobePath);
                console.log('✅ FFprobe set from path:', ffprobePath);
              } catch (ffprobeError: any) {
                console.error('⚠️ Failed to set ffprobe path:', ffprobeError.message);
                ffprobePath = null;
              }
            }
            ffmpegInitialized = true;
            return;
          }
        }
      } catch (e) {
        // Продолжаем поиск
        continue;
      }
    }

    // Если ничего не нашли
    console.error('❌ Failed to find ffmpeg executable. Tried paths:', pathsToTry.slice(0, 20));
    console.error('Current working directory:', process.cwd());
    ffmpegPath = null;
    ffmpegInitialized = true;
  } catch (error: any) {
    console.error('❌ Failed to initialize ffmpeg:', error.message);
    ffmpegPath = null;
    ffmpegInitialized = true;
  }
}

export function ensureFfmpegReady(): void {
  initializeFfmpeg();

  if (!ffmpegPath) {
    throw new Error('FFmpeg is not available. Please ensure @ffmpeg-installer/ffmpeg is installed correctly.');
  }
  if (!ffprobePath) {
    throw new Error('FFprobe is not available. Please ensure @ffprobe-installer/ffprobe is installed correctly.');
  }
}

/**
 * Извлекает первый кадр из видео/GIF
 */
export async function extractFirstFrame(buffer: Buffer, inputExt?: string): Promise<Buffer> {
  // Инициализируем ffmpeg только при первом использовании
  ensureFfmpegReady();
  
  // Определяем расширение для временного файла
  const ext = inputExt || 'mp4';
  const tmpInput = path.join('/tmp', `input-${Date.now()}-${Math.random().toString(36).substring(7)}.${ext}`);
  const tmpOutput = path.join('/tmp', `frame-${Date.now()}-${Math.random().toString(36).substring(7)}.png`);
  
  try {
    await fs.promises.writeFile(tmpInput, buffer);
    console.log('Written input file:', tmpInput, 'Size:', buffer.length);

    await new Promise<void>((resolve, reject) => {
      const command = ffmpeg(tmpInput)
        .outputOptions(['-vframes', '1', '-q:v', '2'])
        .save(tmpOutput)
        .on('start', (cmd) => {
          console.log('FFmpeg command:', cmd);
        })
        .on('progress', (progress) => {
          console.log('FFmpeg progress:', progress);
        })
        .on('end', () => {
          console.log('FFmpeg finished, output:', tmpOutput);
          resolve();
        })
        .on('error', (err: Error) => {
          console.error('FFmpeg error:', err);
          reject(err);
        });
    });

    const frameBuffer = await fs.promises.readFile(tmpOutput);
    console.log('Read frame buffer, size:', frameBuffer.length);
    return frameBuffer;
  } catch (error: any) {
    console.error('extractFirstFrame error:', error);
    throw new Error(`Failed to extract first frame: ${error.message || 'Unknown error'}`);
  } finally {
    // Очистка временных файлов
    await fs.promises.unlink(tmpInput).catch(() => {});
    await fs.promises.unlink(tmpOutput).catch(() => {});
  }
}

/**
 * Получает метаданные видео (длительность и размер)
 */
export async function getVideoMeta(
  buffer: Buffer,
  inputExt?: string
): Promise<{ duration: number; sizeMB: number; width: number; height: number }> {
  // Инициализируем ffmpeg только при первом использовании
  ensureFfmpegReady();
  
  // Определяем расширение для временного файла
  const ext = inputExt || 'mp4';
  const tmpInput = path.join('/tmp', `meta-${Date.now()}-${Math.random().toString(36).substring(7)}.${ext}`);
  
  try {
    await fs.promises.writeFile(tmpInput, buffer);

    const stats = await fs.promises.stat(tmpInput);
    const sizeMB = stats.size / (1024 * 1024);

    const probeResult = await new Promise<{
      duration: number;
      width: number;
      height: number;
    }>((resolve, reject) => {
      ffmpeg.ffprobe(tmpInput, (err: any, metadata: any) => {
        if (err) {
          console.error('FFprobe error:', err);
          reject(err);
        } else {
          const dur = metadata?.format?.duration || 0;
          const videoStream = metadata?.streams?.find((stream: any) => stream.codec_type === 'video');
          const streamWidth = videoStream?.width || 0;
          const streamHeight = videoStream?.height || 0;
          console.log('Video metadata:', { duration: dur, sizeMB, width: streamWidth, height: streamHeight });
          resolve({
            duration: dur,
            width: streamWidth,
            height: streamHeight,
          });
        }
      });
    });

    return {
      duration: probeResult.duration,
      sizeMB,
      width: probeResult.width,
      height: probeResult.height,
    };
  } catch (error: any) {
    console.error('getVideoMeta error:', error);
    throw new Error(`Failed to get video metadata: ${error.message || 'Unknown error'}`);
  } finally {
    // Очистка временного файла
    await fs.promises.unlink(tmpInput).catch(() => {});
  }
}

