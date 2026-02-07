
import React from 'react';
import { AlertTriangle, FileText, Copy, RefreshCw, X, SkipForward } from 'lucide-react';
import { TRANSLATIONS } from '../constants';
import { Language } from '../types';

interface UploadConflictDialogProps {
  isOpen: boolean;
  filename: string;
  onOverwrite: () => void;
  onKeepBoth: () => void;
  onSkip: () => void;
  language: Language;
}

const UploadConflictDialog: React.FC<UploadConflictDialogProps> = ({
  isOpen,
  filename,
  onOverwrite,
  onKeepBoth,
  onSkip,
  language
}) => {
  if (!isOpen) return null;

  const t = (TRANSLATIONS as any)[language] || TRANSLATIONS.en;
  
  // Custom text for this specific dialog
  const labels = {
      vi: {
          title: "Phát hiện trùng lặp tập tin",
          desc: `Tập tin "${filename}" đã tồn tại trong thư mục này.`,
          overwrite: "Ghi đè",
          overwriteDesc: "Thay thế file cũ bằng file mới này.",
          keepBoth: "Tải thêm (Đổi tên)",
          keepBothDesc: "Giữ cả hai, file mới sẽ được thêm số thứ tự.",
          skip: "Bỏ qua",
      },
      en: {
          title: "File Conflict Detected",
          desc: `File "${filename}" already exists in this folder.`,
          overwrite: "Overwrite",
          overwriteDesc: "Replace the existing file with this one.",
          keepBoth: "Keep Both",
          keepBothDesc: "Rename new file and keep both.",
          skip: "Skip",
      },
      zh: {
          title: "发现文件冲突",
          desc: `文件 "${filename}" 已存在。`,
          overwrite: "覆盖",
          overwriteDesc: "用新文件替换旧文件。",
          keepBoth: "保留两者",
          keepBothDesc: "重命名新文件并保留两者。",
          skip: "跳过",
      }
  };

  const text = (labels as any)[language] || labels.en;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-card w-full max-w-md rounded-2xl border border-border shadow-2xl overflow-hidden flex flex-col scale-100 animate-in zoom-in-95 duration-200">
        
        <div className="p-6 bg-muted/30 border-b border-border flex gap-4">
            <div className="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center shrink-0">
                <AlertTriangle className="text-amber-500" size={24} />
            </div>
            <div>
                <h3 className="text-lg font-bold text-foreground">{text.title}</h3>
                <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                    {text.desc}
                </p>
            </div>
        </div>

        <div className="p-4 flex flex-col gap-3">
            <button 
                onClick={onKeepBoth}
                className="flex items-center gap-4 p-4 rounded-xl border border-border bg-background hover:bg-muted/50 hover:border-primary/50 transition-all group text-left"
            >
                <div className="w-10 h-10 rounded-lg bg-blue-500/10 text-blue-500 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform">
                    <Copy size={20} />
                </div>
                <div>
                    <div className="font-bold text-sm">{text.keepBoth}</div>
                    <div className="text-xs text-muted-foreground">{text.keepBothDesc}</div>
                </div>
            </button>

            <button 
                onClick={onOverwrite}
                className="flex items-center gap-4 p-4 rounded-xl border border-border bg-background hover:bg-red-500/5 hover:border-red-500/30 transition-all group text-left"
            >
                <div className="w-10 h-10 rounded-lg bg-red-500/10 text-red-500 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform">
                    <RefreshCw size={20} />
                </div>
                <div>
                    <div className="font-bold text-sm text-red-500 group-hover:text-red-600">{text.overwrite}</div>
                    <div className="text-xs text-muted-foreground">{text.overwriteDesc}</div>
                </div>
            </button>
        </div>

        <div className="p-4 bg-muted/30 border-t border-border flex justify-end">
            <button 
                onClick={onSkip}
                className="px-6 py-2.5 rounded-xl font-bold text-sm text-muted-foreground hover:bg-background hover:text-foreground border border-transparent hover:border-border transition-all flex items-center gap-2"
            >
                <SkipForward size={16} /> {text.skip}
            </button>
        </div>
      </div>
    </div>
  );
};

export default UploadConflictDialog;
