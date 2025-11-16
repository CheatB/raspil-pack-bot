/** @type {import('next').NextConfig} */
const path = require('path');

const nextConfig = {
  images: {
    domains: [],
  },
  swcMinify: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  outputFileTracing: false,
  transpilePackages: ['@repo/processor', '@repo/types'],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Добавляем путь к tg-bot в resolve
      config.resolve.alias = {
        ...config.resolve.alias,
        '@repo/tg-bot': path.resolve(__dirname, '../../apps/tg-bot/src'),
      };
      
      // Настраиваем fallback для Node.js модулей
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
      };
      
      // Исключаем @ffmpeg-installer/ffmpeg из бандлинга (используем нативный require)
      config.externals = config.externals || [];
      config.externals.push({
        '@ffmpeg-installer/ffmpeg': 'commonjs @ffmpeg-installer/ffmpeg',
        '@ffprobe-installer/ffprobe': 'commonjs @ffprobe-installer/ffprobe',
      });
    }
    return config;
  },
};

module.exports = nextConfig;

