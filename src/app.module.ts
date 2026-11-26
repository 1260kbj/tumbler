import { Module } from '@nestjs/common';
import { ApiFallbackController } from './api-fallback.controller';
import { AuthController } from './auth.controller';
import { CatalogController } from './catalog.controller';
import { HomeController } from './home.controller';
import { InspectionsController } from './inspections.controller';
import { InspectionStore } from './inspection.store';
import { GeminiResultStore } from './gemini-result.store';
import { EvidenceQueryStore } from './evidence-query.store';
import { EvidenceLinkStore } from './evidence-link.store';
import { GoogleWebAppClient } from './google-web-app.client';
import { NotebookLMClient } from './notebooklm.client';
import { OperationsController } from './operations.controller';
import { PromptsController } from './prompts.controller';
import { DrivePhotoController } from './drive-photo.controller';

@Module({
  controllers: [AuthController, CatalogController, HomeController, InspectionsController, OperationsController, PromptsController, DrivePhotoController, ApiFallbackController],
  providers: [GoogleWebAppClient, InspectionStore, GeminiResultStore, EvidenceQueryStore, EvidenceLinkStore, NotebookLMClient],
})
export class AppModule {}