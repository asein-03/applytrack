import type { ApplicationDocument } from './types.js';

export interface DocumentUsage {
  applicationId: string;
  documentId: string;
  company: string;
  role: string;
  name: string;
  status: ApplicationDocument['status'];
  detectedAt: string;
  submittedAt: string | null;
  stored: boolean;
  current: boolean;
}

export interface LibraryDocument {
  id: string;
  kind: ApplicationDocument['kind'];
  label: string;
  name: string;
  names: string[];
  size: number;
  mimeType: string;
  sha256: string | null;
  firstDetectedAt: string;
  lastDetectedAt: string;
  stored: boolean;
  usages: DocumentUsage[];
}
