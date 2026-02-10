
import React, { useRef, useEffect, useState } from 'react';
import { Message, Role, ChatSession, Language, Document } from '../types';
import { Send, Bot, User, Cpu, FileText, Plus, MessageSquare, Trash2, Menu, X, Download, Eye, AlertTriangle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { TRANSLATIONS } from '../constants';

interface ChatInterfaceProps {
  messages: Message[];
  isLoading: boolean;
  input: string;
  onInputChange: (val: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  hasContext: boolean;
  documents?: Document[];
  onViewDocument?: (filename: string) => void;
  sessions: ChatSession[];
  currentSessionId: string | null;
  onNewChat: () => void;
  onSelectSession: (session: ChatSession) => void;
  onDeleteSession: (sessionId: string) => void;
  language?: Language;
}

const ChatInterface: React.FC<ChatInterfaceProps> = ({
  messages, isLoading, input, onInputChange, onSubmit, hasContext, documents = [], onViewDocument,
  sessions, currentSessionId, onNewChat, onSelectSession, onDeleteSession, language = 'vi'
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const t = (TRANSLATIONS as any)[language] || TRANSLATIONS.en;

  const scrollToBottom = () => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  useEffect(() => { scrollToBottom(); }, [messages]);

  const handleDownloadFile = (filename: string) => {
    const doc = documents.find(d => d.name === filename);
    if (!doc) return;
    try {
      const link = document.createElement('a');
      link.href = doc.content;
      link.download = doc.name;
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (e) { }
  };

  const findDocByRef = (ref: string): Document | undefined => {
    const trimmed = ref.trim();
    return documents.find(d => d.name.toLowerCase() === trimmed.toLowerCase() || d.name.includes(trimmed) || trimmed.includes(d.name));
  };

  const cleanContent = (raw: string) => raw.replace(/\[\[File:\s*([^\]]*?)\]\]/g, '').trim();

  const renderContent = (content: string) => {
    const fileRegex = /\[\[File:\s*([^\]]*?)\]\]/g;
    const uniqueFileRefs = Array.from(new Set(Array.from(content.matchAll(fileRegex)).map(m => m[1].trim())));

    return (
      <div className="space-y-4">
        <div className="prose prose-sm dark:prose-invert max-w-none break-words">
          <ReactMarkdown>
            {cleanContent(content)}
          </ReactMarkdown>
        </div>
        {uniqueFileRefs.length > 0 && (
          <div className="flex flex-col gap-3 mt-4 pt-4 border-t border-white/10">
            <p className="text-[10px] font-black uppercase tracking-widest text-primary opacity-90 flex items-center gap-2">
                <FileText size={12}/> TÀI LIỆU CẦN KIỂM TRA
            </p>
            {uniqueFileRefs.map((ref, idx) => {
              const doc = findDocByRef(ref);
              const docName = doc ? doc.name : ref;
              const isFound = !!doc;
              
              return (
                <div key={idx} className={`flex items-center gap-4 p-4 rounded-2xl border transition-all shadow-lg max-w-xl ${isFound ? 'bg-primary/5 border-primary/20 hover:bg-primary/10' : 'bg-red-500/5 border-red-500/20'}`}>
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${isFound ? 'bg-primary/10 text-primary border-primary/20' : 'bg-red-500/10 text-red-500 border-red-500/20'}`}>
                    {isFound ? <FileText size={20} /> : <AlertTriangle size={20} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-xs truncate text-foreground" title={docName}>{docName}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {isFound ? `${(doc.size / 1024 / 1024).toFixed(2)} MB` : 'File không tìm thấy'}
                    </div>
                  </div>
                  {isFound && (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => onViewDocument?.(docName)}
                          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-all font-bold text-[10px] uppercase"
                        >
                          <Eye size={12} /> Xem
                        </button>
                        <button
                          onClick={() => handleDownloadFile(docName)}
                          className="p-2 rounded-lg text-muted-foreground hover:bg-white/10 hover:text-foreground transition-all border border-white/10"
                        >
                          <Download size={14} />
                        </button>
                      </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full w-full bg-transparent overflow-hidden relative">
      <div className={`absolute md:relative z-20 h-full w-80 bg-card/40 backdrop-blur-3xl border-r border-white/5 flex flex-col transition-transform duration-500 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <div className="p-6 border-b border-white/5">
          <button onClick={() => { onNewChat(); setIsSidebarOpen(false); }} className="w-full flex items-center justify-center gap-3 bg-primary text-white hover:bg-primary/90 px-6 py-4 rounded-2xl transition-all font-black text-[10px] uppercase tracking-widest shadow-lg shadow-primary/20">
            <Plus size={18} /> <span>{t.newChat}</span>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
          {sessions.map((session) => (
            <div key={session.id} className={`group flex items-center justify-between p-4 rounded-2xl cursor-pointer transition-all border ${currentSessionId === session.id ? 'bg-primary/10 border-primary/20 text-foreground' : 'border-transparent text-muted-foreground hover:bg-white/5'}`} onClick={() => { onSelectSession(session); setIsSidebarOpen(false); }}>
              <div className="flex items-center gap-4 truncate flex-1">
                <MessageSquare size={16} className={currentSessionId === session.id ? "text-primary" : "opacity-30"} />
                <span className="truncate font-black text-[11px] uppercase">{session.title || "Observation Matrix"}</span>
              </div>
              <button onClick={(e) => { e.stopPropagation(); onDeleteSession(session.id); }} className="p-2 rounded-xl opacity-0 group-hover:opacity-100 hover:text-red-500 transition-all"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 flex flex-col h-full relative w-full bg-transparent">
        <div className="md:hidden absolute top-4 left-4 z-30">
          <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="p-3 bg-card/60 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl">
            {isSidebarOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 md:p-12 space-y-10 scroll-smooth custom-scrollbar relative">
          <div className="absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent pointer-events-none" />
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-8 animate-fade-in relative z-10">
              <div className="w-24 h-24 bg-primary/20 rounded-[2rem] flex items-center justify-center mb-8 ring-1 ring-white/10 animate-float">
                <Cpu className="w-12 h-12 text-primary" />
              </div>
              <h3 className="text-3xl font-black mb-4 tracking-tighter uppercase">{hasContext ? "Hệ thống Tra cứu Tài liệu" : "Chưa có tài liệu"}</h3>
              <p className="max-w-md text-muted-foreground font-black text-[10px] uppercase tracking-widest opacity-60 leading-relax">
                {hasContext ? "Sử dụng AI để tra cứu thông tin chính xác từ các tệp đã tải lên." : "Vui lòng tải tệp lên để bắt đầu tra cứu."}
              </p>
            </div>
          ) : (
            messages.map((msg) => (
              <div key={msg.id} className={`flex w-full animate-slide-up ${msg.role === Role.USER ? 'justify-end' : 'justify-start'} relative z-10`}>
                <div className={`flex max-w-[95%] lg:max-w-[85%] gap-6 ${msg.role === Role.USER ? 'flex-row-reverse' : 'flex-row'}`}>
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 shadow-xl ${msg.role === Role.USER ? 'bg-primary text-white' : 'bg-card border border-white/10 text-primary'}`}>
                    {msg.role === Role.USER ? <User size={20} /> : <Bot size={20} />}
                  </div>
                  <div className={`p-6 rounded-[1.5rem] shadow-xl border ${msg.role === Role.USER ? 'bg-primary/90 text-white border-primary rounded-tr-none' : 'glass-panel border-white/10 rounded-tl-none'}`}>
                    <div className="text-sm leading-relaxed">{renderContent(msg.content)}</div>
                  </div>
                </div>
              </div>
            ))
          )}
          {isLoading && (
            <div className="flex justify-start w-full relative z-10">
              <div className="flex max-w-[80%] gap-6">
                <div className="w-10 h-10 rounded-xl bg-card border border-white/10 flex items-center justify-center text-primary shadow-xl"><Bot size={20} /></div>
                <div className="glass-panel border-white/10 p-4 rounded-2xl rounded-tl-none flex items-center gap-2"><span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" /><span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce delay-75" /><span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce delay-150" /></div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} className="h-10" />
        </div>

        <div className="p-6 md:p-10 bg-transparent relative z-20">
          <form onSubmit={onSubmit} className="max-w-4xl mx-auto relative group">
            <input type="text" value={input} onChange={(e) => onInputChange(e.target.value)} placeholder={hasContext ? "Hỏi bất cứ điều gì về tài liệu..." : "Hệ thống đang chờ tải tệp..."} disabled={isLoading} className="w-full glass-panel border-white/10 rounded-[2rem] px-8 py-5 pr-16 text-sm font-bold focus:outline-none ring-4 ring-transparent focus:ring-primary/10 transition-all shadow-2xl relative z-10" />
            <button type="submit" disabled={!input.trim() || isLoading} className="absolute right-3 top-1/2 -translate-y-1/2 w-12 h-12 bg-primary text-white rounded-2xl hover:scale-105 active:scale-95 disabled:opacity-30 transition-all shadow-xl z-20 flex items-center justify-center"><Send size={20} /></button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default ChatInterface;
