// Telegram update interfaces
export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramPhoto extends TelegramFile {
  width: number;
  height: number;
}

export interface TelegramVideo extends TelegramFile {
  width: number;
  height: number;
  duration: number;
  thumb?: TelegramPhoto;
  mime_type?: string;
}

export interface TelegramAnimation extends TelegramFile {
  width: number;
  height: number;
  duration: number;
  thumb?: TelegramPhoto;
  mime_type?: string;
}

// Processing interfaces
export interface ProcessedTile {
  buffer: Buffer;
  width: number;
  height: number;
  index: number;
}

export interface MosaicResult {
  tiles: ProcessedTile[];
  preview?: Buffer;
  totalWidth: number;
  totalHeight: number;
}

// API response interfaces
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface WebhookResponse {
  ok: boolean;
  error?: string;
}

