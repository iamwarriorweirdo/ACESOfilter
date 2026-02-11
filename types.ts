
export enum Role {
  USER = 'user',
  MODEL = 'model',
  SYSTEM = 'system'
}

export type UserRole = 'superadmin' | 'it' | 'hr' | 'employee';

export type Language = 'en' | 'vi' | 'zh';

export type Theme = 'light' | 'dark';

export type ViewState = 'login' | 'dashboard' | 'settings';

export interface Message {
  id: string;
  role: Role;
  content: string;
  timestamp: number;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: number;
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
}

export interface Document {
  id: string;
  name: string;
  type: string;
  folderId: string | null;
  content: string;
  size: number;
  uploadDate: number;
  lastModified?: number;
  uploadedBy: string;
  extractedContent?: string;
  category?: string;
  status?: string;
}

export interface User {
  username: string;
  role: UserRole;
  createdAt: number;
  createdBy?: string;
}

export interface SystemConfig {
  maintenanceMode: boolean;
  allowPublicUpload: boolean;
  aiModel: string; // Legacy/Default
  ocrModel?: string;      // Dedicated for Vision/OCR
  analysisModel?: string; // Dedicated for Metadata/JSON extraction
  chatModel?: string;     // Dedicated for RAG Chat UI
  embeddingModel?: string; // Dedicated for Vector Search
  hfModel?: string;       // Hugging Face Model ID
  maxFileSizeMB: number;
  
  // Dedicated API Keys to split load
  ocrApiKey?: string;     // NEW: Key specific for heavy OCR/Ingestion tasks

  // Adobe PDF Services Integration
  enableAdobeCompression?: boolean;
  adobeClientId?: string;
  adobeClientSecret?: string;
  adobeOrgId?: string;
}

export interface UsageStats {
  model: string;
  total_tokens: number;
  total_requests: number;
  last_used: number;
}

export interface BackendFile {
  name: string;
  path: string;
  language: string;
  content: string;
}
