import { BadRequestException, Injectable } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GoogleWebAppClient } from './google-web-app.client';
import type { Inspection, InspectionDecision, LocalState } from './inspection.types';
import {
  inspectionDefectNames,
  type InspectionRecord,
  type InspectionRecordDefect,
  type InspectionRecordWithDefects,
  type InspectionView,
} from './inspection-record.types';
import { getStorageInfo } from './storage-mode';

export interface PreparedPhoto {
  name: string;
  mimeType: string;
  base64: string;
}

interface GoogleInspectionData {
  inspections?: Record<string, unknown>[];
  images?: Record<string, unknown>[];
  inspection_records?: Array<Omit<InspectionRecord, 'weight_g' | 'content_version' | 'notes' | 'change_reason'> & {
    weight_g: number | string | null;
    content_version: number | string;
    notes: string | null;
    change_reason: string | null;
  }>;
  record_defects?: InspectionRecordDefect[];
}

interface GoogleInspectionRecordData {
  records: Array<Omit<InspectionRecord, 'weight_g' | 'content_version' | 'notes' | 'change_reason'> & {
    weight_g: number | string | null;
    content_version: number | string;
    notes: string | null;
    change_reason: string | null;
  }>;
  defects: InspectionRecordDefect[];
}

function toOptionalNumber(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function toOptionalDecision(value: unknown): InspectionDecision {
  if (value === '' || value === null || value === undefined) return null;
  const text = String(value);
  if (text === 'OK' || text === 'NG' || text === 'HOLD') return text;
  return null;
}

@Injectable()
export class InspectionStore {
  private readonly filePath = path.join(process.cwd(), 'runtime', 'local-state.json');

  constructor(private readonly googleWebAppClient: GoogleWebAppClient) {}

  async getAll(): Promise<InspectionView[]> {
    if (getStorageInfo().storage === 'live') {
      return this.getGoogleInspections();
    }
    return this.withLatestRecords(this.getLocalState());
  }

  private async getGoogleInspections(): Promise<InspectionView[]> {
    const data = await this.googleWebAppClient.call<GoogleInspectionData>('read', {
      tabs: ['inspections', 'images', 'inspection_records', 'record_defects'],
    });
    const imageRows = Array.isArray(data.images) ? data.images : [];
    const imagesByInspection = new Map<string, { position: number; url: string }[]>();

    for (const row of imageRows) {
      const inspectionId = String(row.inspection_id ?? '');
      const url = String(row.image_url ?? '');
      if (!inspectionId || !url) continue;
      const list = imagesByInspection.get(inspectionId) ?? [];
      list.push({ position: Number(row.position ?? 0), url });
      imagesByInspection.set(inspectionId, list);
    }

    const inspectionRows = Array.isArray(data.inspections) ? data.inspections : [];
    const inspections: Inspection[] = inspectionRows.map((row) => {
      const inspectionId = String(row.inspection_id ?? '');
      const sortedImages = (imagesByInspection.get(inspectionId) ?? [])
        .sort((a, b) => a.position - b.position)
        .map((item) => item.url);

      return {
        inspection_id: inspectionId,
        product_id: String(row.product_id ?? ''),
        inspected_at: String(row.inspected_at ?? ''),
        revision: row.revision === 'Rev.B' ? 'Rev.B' : 'Rev.A',
        weight_g: toOptionalNumber(row.weight_g),
        memo: row.memo === null || row.memo === undefined ? '' : String(row.memo),
        decision: toOptionalDecision(row.decision),
        content_version: Number(row.content_version ?? 0),
        images: sortedImages,
      };
    });

    const inspection_records: InspectionRecord[] = (data.inspection_records ?? []).map((row) => ({
      ...row,
      weight_g: toOptionalNumber(row.weight_g),
      content_version: Number(row.content_version) || 0,
      notes: row.notes ?? '',
      change_reason: row.change_reason ?? '',
    }));

    return this.withLatestRecords({
      inspections,
      inspection_records,
      record_defects: data.record_defects ?? [],
    });
  }

  private getLocalState(): LocalState {
    if (!existsSync(this.filePath)) {
      return { inspections: [], inspection_records: [], record_defects: [] };
    }
    const state = JSON.parse(readFileSync(this.filePath, 'utf8')) as LocalState;
    state.inspections = Array.isArray(state.inspections) ? state.inspections : [];
    state.inspection_records = Array.isArray(state.inspection_records) ? state.inspection_records : [];
    state.record_defects = Array.isArray(state.record_defects) ? state.record_defects : [];
    return state;
  }

  private saveLocal(inspection: Inspection): void {
    const state = this.getLocalState();
    const inspections = state.inspections;
    const index = inspections.findIndex((item) => item.inspection_id === inspection.inspection_id);
    const { defects: _defects, ...storedInspection } = inspection as InspectionView;
    const previousInspection = inspections[index];
    if (
      previousInspection &&
      state.inspection_records!.some((record) => record.inspection_id === inspection.inspection_id)
    ) {
      storedInspection.decision = previousInspection.decision;
      storedInspection.memo = previousInspection.memo;
    }
    if (index < 0) inspections.push(storedInspection);
    else inspections[index] = storedInspection;

    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(state, null, 2), 'utf8');
    renameSync(temporaryPath, this.filePath);
  }

  async saveRecord(
    inspection: Inspection,
    record: InspectionRecord,
    defects: string[],
  ): Promise<void> {
    if (getStorageInfo().storage === 'live') {
      const result = await this.googleWebAppClient.call<{ saved: number }>('saveInspectionRecord', {
        record,
        defects,
      });
      if (result.saved !== 1) throw new Error('판단을 저장하지 못했습니다.');
      return;
    }

    const state = this.getLocalState();
    state.inspection_records!.push(record);
    state.record_defects!.push(
      ...defects.map((defect_code): InspectionRecordDefect => ({
        record_id: record.record_id,
        defect_code,
      })),
    );
    const storedInspection = state.inspections.find(
      (item) => item.inspection_id === inspection.inspection_id,
    );
    if (!storedInspection) throw new Error('검사를 찾을 수 없습니다.');
    storedInspection.content_version = record.content_version;

    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(state, null, 2), 'utf8');
    renameSync(temporaryPath, this.filePath);
  }

  async getRecords(inspectionId: string): Promise<InspectionRecordWithDefects[]> {
    let records: InspectionRecord[];
    let defects: InspectionRecordDefect[];
    if (getStorageInfo().storage === 'live') {
      const response = await this.googleWebAppClient.call<GoogleInspectionRecordData>('listInspectionRecords', {
        inspection_id: inspectionId,
      });
      records = (response.records ?? []).map((record) => ({
        ...record,
        weight_g: toOptionalNumber(record.weight_g),
        content_version: Number(record.content_version) || 0,
        notes: record.notes ?? '',
        change_reason: record.change_reason ?? '',
      }));
      defects = response.defects ?? [];
    } else {
      const state = this.getLocalState();
      records = state.inspection_records!.filter((record) => record.inspection_id === inspectionId);
      defects = state.record_defects!;
    }

    const defectsByRecord = new Map<string, InspectionRecordDefect[]>();
    for (const defect of defects) {
      const items = defectsByRecord.get(defect.record_id) ?? [];
      items.push(defect);
      defectsByRecord.set(defect.record_id, items);
    }

    return records
      .map((record, originalIndex) => ({
        ...record,
        originalIndex,
        defects: (defectsByRecord.get(record.record_id) ?? []).map(({ defect_code }) => ({
          defect_code,
          defect_name: inspectionDefectNames[defect_code] ?? defect_code,
        })),
      }))
      .sort((left, right) =>
        right.content_version - left.content_version ||
        right.recorded_at.localeCompare(left.recorded_at) ||
        right.originalIndex - left.originalIndex,
      )
      .map(({ originalIndex: _originalIndex, ...record }) => record);
  }

  async register(inspection: Inspection, photos: PreparedPhoto[]): Promise<Inspection> {
    if (photos.length === 0) throw new BadRequestException('사진을 골라 주세요.');

    if (getStorageInfo().storage === 'live') {
      return this.registerGoogle(inspection, photos);
    }

    const savedInspection = {
      ...inspection,
      images: photos.map((photo) => this.saveLocalPhoto(photo)),
    };
    this.saveLocal(savedInspection);
    return savedInspection;
  }

  private async registerGoogle(inspection: Inspection, photos: PreparedPhoto[]): Promise<Inspection> {
    const imageUrls: string[] = [];
    for (const photo of photos) {
      const saved = await this.googleWebAppClient.call<{ id: string }>('savePhoto', {
        name: photo.name,
        mimeType: photo.mimeType,
        base64: photo.base64,
      });
      imageUrls.push(`/api/drive/${saved.id}`);
    }

    await this.googleWebAppClient.call('append', {
      rows: {
        inspections: [
          {
            inspection_id: inspection.inspection_id,
            product_id: inspection.product_id,
            inspected_at: inspection.inspected_at,
            revision: inspection.revision,
            weight_g: inspection.weight_g,
            memo: inspection.memo,
            decision: inspection.decision,
            content_version: inspection.content_version,
          },
        ],
        images: imageUrls.map((url, index) => ({
          inspection_id: inspection.inspection_id,
          position: index + 1,
          image_url: url,
        })),
      },
    });

    return {
      ...inspection,
      images: imageUrls,
    };
  }

  private saveLocalPhoto(photo: PreparedPhoto): string {
    const uploadsDirectory = path.join(process.cwd(), 'runtime', 'uploads');
    mkdirSync(uploadsDirectory, { recursive: true });
    writeFileSync(path.join(uploadsDirectory, photo.name), Buffer.from(photo.base64, 'base64'));
    return `/uploads/${photo.name}`;
  }

  async update(inspection: Inspection): Promise<void> {
    if (getStorageInfo().storage === 'live') {
      await this.googleWebAppClient.call('update', {
        tab: 'inspections',
        key: 'inspection_id',
        value: inspection.inspection_id,
        changes: {
          product_id: inspection.product_id,
          inspected_at: inspection.inspected_at,
          weight_g: inspection.weight_g,
          content_version: inspection.content_version,
        },
      });
      return;
    }

    this.saveLocal(inspection);
  }

  async find(inspectionId: string): Promise<InspectionView | undefined> {
    return (await this.getAll()).find((item) => item.inspection_id === inspectionId);
  }

  private withLatestRecords(state: LocalState): InspectionView[] {
    const latestByInspection = new Map<string, InspectionRecord>();
    for (const record of state.inspection_records ?? []) {
      const current = latestByInspection.get(record.inspection_id);
      if (
        !current ||
        record.content_version > current.content_version ||
        (record.content_version === current.content_version &&
          record.recorded_at.localeCompare(current.recorded_at) >= 0)
      ) {
        latestByInspection.set(record.inspection_id, record);
      }
    }

    const defectsByRecord = new Map<string, InspectionRecordDefect[]>();
    for (const defect of state.record_defects ?? []) {
      const items = defectsByRecord.get(defect.record_id) ?? [];
      items.push(defect);
      defectsByRecord.set(defect.record_id, items);
    }

    return state.inspections.map((inspection) => {
      const latest = latestByInspection.get(inspection.inspection_id);
      if (!latest) return { ...inspection, defects: [] };
      return {
        ...inspection,
        decision: latest.decision,
        memo: latest.notes,
        defects: (defectsByRecord.get(latest.record_id) ?? []).map(({ defect_code }) => ({
          defect_code,
          defect_name: inspectionDefectNames[defect_code] ?? defect_code,
        })),
      };
    });
  }
}
