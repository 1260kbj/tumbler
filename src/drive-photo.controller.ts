import { Controller, Get, Param, StreamableFile } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GoogleWebAppClient } from './google-web-app.client';
import { getStorageInfo } from './storage-mode';

interface DrivePhotoResult {
  mimeType: string;
  base64: string;
}

@Controller('api/drive')
export class DrivePhotoController {
  constructor(private readonly googleWebAppClient: GoogleWebAppClient) {}

  @Get(':fileId')
  async getPhoto(@Param('fileId') fileId: string): Promise<StreamableFile> {
    if (getStorageInfo().storage === 'live') {
      const photo = await this.googleWebAppClient.call<DrivePhotoResult>('getPhoto', { id: fileId });
      return new StreamableFile(Buffer.from(photo.base64, 'base64'), {
        type: photo.mimeType || 'image/png',
      });
    }

    const filePath = path.join(process.cwd(), 'runtime', 'uploads', fileId);
    const contents = readFileSync(filePath);
    const extension = path.extname(fileId).toLowerCase();
    const mimeType = extension === '.jpg' || extension === '.jpeg'
      ? 'image/jpeg'
      : extension === '.webp'
        ? 'image/webp'
        : 'image/png';
    return new StreamableFile(contents, { type: mimeType });
  }
}
