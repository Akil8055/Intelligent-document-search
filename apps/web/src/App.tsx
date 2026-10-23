import React, { useState, useEffect, useRef } from 'react';
import {
  Search,
  Upload,
  FileText,
  Trash2,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Clock,
  Sparkles,
  BookOpen,
  Layers,
  ShieldCheck,
  User,
  LogOut,
  ChevronRight,
  ExternalLink,
  SlidersHorizontal,
} from 'lucide-react';

interface AuthUser {
  id: string;
  email: string;
  role: string;
}

interface DocumentItem {
  id: string;
  original_name: string;
  file_size: number;
  page_count: number;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  error_message: string | null;
  created_at: string;
}

interface SearchResult {
  chunk_id: string;
  document_id: string;
  document_name: string;
  page_number: number;
  chunk_index: number;
  content: string;
  score: number;
  search_mode: string;
  details?: {
    keyword_rank?: number;
    semantic_rank?: number;
    reranker_score?: number;
    rrf_score?: number;
  };
}

interface Citation {
  citation_id: number;
  document_id: string;
  document_name: string;
  page_number: number;
  chunk_index: number;
  quoted_passage: string;
  relevance_score: number;
}

interface GroundedAnswer {
  query: string;
  answer: string;
  has_sufficient_evidence: boolean;
  evidence_score: number;
  citations: Citation[];
}

export function App() {
  // Auth state
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [user, setUser] = useState<AuthUser | null>(() => {
    const saved = localStorage.getItem('user');
    return saved ? JSON.parse(saved) : null;
  });
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');

  // Documents state
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');

  // Search & Q&A state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'hybrid' | 'semantic' | 'keyword'>('hybrid');
  const [useReranker, setUseReranker] = useState(false);
  const [useGroundedAnswer, setUseGroundedAnswer] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [groundedAnswer, setGroundedAnswer] = useState<GroundedAnswer | null>(null);
  const [searchLatency, setSearchLatency] = useState<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Headers helper
  const getHeaders = () => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  };

  // Fetch documents list
  const fetchDocuments = async () => {
    try {
      const res = await fetch('/api/v1/documents', {
        headers: getHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setDocuments(data.documents || []);
      }
    } catch (e) {
      console.error('Error fetching documents:', e);
    }
  };

  useEffect(() => {
    fetchDocuments();
  }, [token]);

  // Polling for processing documents
  useEffect(() => {
    const hasPending = documents.some((d) => d.status === 'queued' || d.status === 'processing');
    if (!hasPending) return;

    const interval = setInterval(() => {
      fetchDocuments();
    }, 2000);

    return () => clearInterval(interval);
  }, [documents]);

  // Auth Handler
  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError('');
    try {
      const endpoint = authMode === 'login' ? '/api/v1/auth/login' : '/api/v1/auth/register';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: authEmail, password: authPassword }),
      });

      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || 'Authentication failed');
        return;
      }

      setToken(data.token);
      setUser(data.user);
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      setShowAuthModal(false);
      setAuthEmail('');
      setAuthPassword('');
    } catch (err: any) {
      setAuthError(err.message || 'Network error');
    }
  };

  const handleLogout = () => {
    setToken(null);
    setUser(null);
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setDocuments([]);
    setSearchResults([]);
    setGroundedAnswer(null);
  };

  // Upload handler
  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) return;

    setIsUploading(true);
    setUploadError('');

    const formData = new FormData();
    formData.append('file', selectedFile);

    try {
      const res = await fetch('/api/v1/documents', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Upload failed');
      }

      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await fetchDocuments();
    } catch (err: any) {
      setUploadError(err.message);
    } finally {
      setIsUploading(false);
    }
  };

  // Delete handler
  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this document and its vector indices?')) return;
    try {
      await fetch(`/api/v1/documents/${id}`, {
        method: 'DELETE',
        headers: getHeaders(),
      });
      await fetchDocuments();
    } catch (e) {
      console.error('Delete failed:', e);
    }
  };

  // Retry handler
  const handleRetry = async (id: string) => {
    try {
      await fetch(`/api/v1/documents/${id}/retry`, {
        method: 'POST',
        headers: getHeaders(),
      });
      await fetchDocuments();
    } catch (e) {
      console.error('Retry failed:', e);
    }
  };

  // Search handler
  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    setGroundedAnswer(null);
    const startT = performance.now();

    try {
      if (useGroundedAnswer) {
        // Fetch grounded answer with citations
        const answerRes = await fetch('/api/v1/answers', {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({ query: searchQuery }),
        });
        if (answerRes.ok) {
          const answerData = await answerRes.json();
          setGroundedAnswer(answerData);
        }
      }

      // Fetch ranked passages
      const searchRes = await fetch('/api/v1/search', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          query: searchQuery,
          mode: searchMode,
          top_k: 5,
          rerank: useReranker,
        }),
      });

      if (searchRes.ok) {
        const searchData = await searchRes.json();
        setSearchResults(searchData.results || []);
      }
    } catch (err) {
      console.error('Search error:', err);
    } finally {
      setSearchLatency(Math.round(performance.now() - startT));
      setIsSearching(false);
    }
  };

  return (
    <div style={{ maxWidth: '1280px', margin: '0 auto', padding: '1.5rem 1rem' }}>
      {/* Top Navbar */}
      <header
        className="glass-panel"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '1rem 1.5rem',
          marginBottom: '2rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '10px',
              background: 'linear-gradient(135deg, #6366f1, #06b6d4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 15px rgba(99, 102, 241, 0.4)',
            }}
          >
            <Layers size={22} color="#ffffff" />
          </div>
          <div>
            <h1 style={{ fontSize: '1.25rem', fontWeight: 800, letterSpacing: '-0.02em' }}>DocSearch Intelligence</h1>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Hybrid Lexical (PostgreSQL) + FAISS Vectors + Cross-Encoder
            </p>
          </div>
        </div>

        {/* User Account Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {user ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div style={{ textAlign: 'right' }}>
                <span style={{ fontSize: '0.8125rem', fontWeight: 600, display: 'block' }}>{user.email}</span>
                <span className="badge badge-completed" style={{ fontSize: '0.6875rem' }}>
                  {user.role}
                </span>
              </div>
              <button className="btn btn-secondary" onClick={handleLogout} title="Log Out">
                <LogOut size={16} />
              </button>
            </div>
          ) : (
            <button className="btn btn-primary" onClick={() => setShowAuthModal(true)}>
              <User size={16} /> Sign In
            </button>
          )}
        </div>
      </header>

      {/* Main Grid: Upload & Document Management (Left) + Search & Grounded Answers (Right) */}
      <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: '1.5rem' }}>
        {/* Left Column: Document Upload & List */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Upload Card */}
          <div className="glass-panel" style={{ padding: '1.25rem' }}>
            <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Upload size={18} color="var(--primary)" /> Ingest PDF Document
            </h2>

            <form onSubmit={handleUpload}>
              <div
                style={{
                  border: '2px dashed var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  padding: '1.5rem 1rem',
                  textAlign: 'center',
                  background: selectedFile ? 'rgba(99, 102, 241, 0.05)' : 'transparent',
                  cursor: 'pointer',
                  marginBottom: '1rem',
                  transition: 'border-color 0.2s',
                }}
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  accept=".pdf,application/pdf"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    if (e.target.files && e.target.files[0]) {
                      setSelectedFile(e.target.files[0]);
                    }
                  }}
                />
                <FileText size={32} color={selectedFile ? '#6366f1' : 'var(--text-muted)'} style={{ margin: '0 auto 0.5rem' }} />
                {selectedFile ? (
                  <div>
                    <p style={{ fontSize: '0.875rem', fontWeight: 600 }}>{selectedFile.name}</p>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB
                    </p>
                  </div>
                ) : (
                  <div>
                    <p style={{ fontSize: '0.875rem', fontWeight: 500 }}>Click or drop PDF here</p>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Up to 25MB supported</p>
                  </div>
                )}
              </div>

              {uploadError && (
                <div style={{ padding: '0.5rem', background: 'rgba(244, 63, 94, 0.1)', color: '#fda4af', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem', marginBottom: '0.75rem' }}>
                  {uploadError}
                </div>
              )}

              <button
                type="submit"
                className="btn btn-primary"
                style={{ width: '100%' }}
                disabled={!selectedFile || isUploading}
              >
                {isUploading ? (
                  <>
                    <RefreshCw size={16} className="spinner" /> Enqueuing Ingestion...
                  </>
                ) : (
                  <>
                    <Upload size={16} /> Ingest Document
                  </>
                )}
              </button>
            </form>
          </div>

          {/* Document Inventory */}
          <div className="glass-panel" style={{ padding: '1.25rem', flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
              <h2 style={{ fontSize: '1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <BookOpen size={18} color="var(--accent-cyan)" /> Documents ({documents.length})
              </h2>
              <button
                className="btn btn-secondary"
                style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                onClick={fetchDocuments}
                title="Refresh Documents"
              >
                <RefreshCw size={12} />
              </button>
            </div>

            {documents.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '2rem 1rem', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                No documents uploaded yet. Upload a PDF to begin indexing!
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {documents.map((doc) => (
                  <div
                    key={doc.id}
                    style={{
                      background: 'rgba(15, 23, 42, 0.6)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-md)',
                      padding: '0.875rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.5rem',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.5rem' }}>
                      <span
                        style={{
                          fontSize: '0.875rem',
                          fontWeight: 600,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          maxWidth: '200px',
                        }}
                        title={doc.original_name}
                      >
                        {doc.original_name}
                      </span>
                      <button
                        onClick={() => handleDelete(doc.id)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--text-muted)',
                          cursor: 'pointer',
                          padding: '2px',
                        }}
                        title="Delete Document"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                      <span className={`badge badge-${doc.status}`}>
                        <span className={`status-dot ${doc.status}`} />
                        {doc.status}
                      </span>
                      <span style={{ color: 'var(--text-muted)' }}>
                        {doc.page_count > 0 ? `${doc.page_count} pages` : `${(doc.file_size / 1024).toFixed(0)} KB`}
                      </span>
                    </div>

                    {doc.status === 'failed' && (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.25rem' }}>
                        <span style={{ fontSize: '0.6875rem', color: '#fda4af' }}>{doc.error_message || 'Ingestion failed'}</span>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '0.2rem 0.5rem', fontSize: '0.6875rem' }}
                          onClick={() => handleRetry(doc.id)}
                        >
                          Retry
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Search & Grounded Retrieval Engine */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Search Controls Card */}
          <div className="glass-panel" style={{ padding: '1.5rem' }}>
            <form onSubmit={handleSearch}>
              <div style={{ position: 'relative', marginBottom: '1rem' }}>
                <Search
                  size={20}
                  color="var(--text-muted)"
                  style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)' }}
                />
                <input
                  type="text"
                  className="input-field"
                  style={{ paddingLeft: '2.75rem', paddingRight: '6rem', fontSize: '1rem' }}
                  placeholder="Ask a question or search for technical terms, concepts, acronyms..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                <button
                  type="submit"
                  className="btn btn-primary"
                  style={{ position: 'absolute', right: '0.375rem', top: '50%', transform: 'translateY(-50%)', padding: '0.5rem 1rem' }}
                  disabled={isSearching || !searchQuery.trim()}
                >
                  {isSearching ? <RefreshCw size={16} className="spinner" /> : 'Search'}
                </button>
              </div>

              {/* Retrieval Modes & Reranking Options */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', paddingTop: '0.5rem' }}>
                {/* Search Mode Segmented Control */}
                <div style={{ display: 'inline-flex', background: 'var(--bg-input)', padding: '0.25rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
                  <button
                    type="button"
                    style={{
                      background: searchMode === 'hybrid' ? 'var(--primary)' : 'transparent',
                      color: searchMode === 'hybrid' ? '#ffffff' : 'var(--text-secondary)',
                      border: 'none',
                      borderRadius: 'var(--radius-sm)',
                      padding: '0.375rem 0.75rem',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                    onClick={() => setSearchMode('hybrid')}
                  >
                    Hybrid (RRF)
                  </button>
                  <button
                    type="button"
                    style={{
                      background: searchMode === 'semantic' ? 'var(--primary)' : 'transparent',
                      color: searchMode === 'semantic' ? '#ffffff' : 'var(--text-secondary)',
                      border: 'none',
                      borderRadius: 'var(--radius-sm)',
                      padding: '0.375rem 0.75rem',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                    onClick={() => setSearchMode('semantic')}
                  >
                    Semantic (FAISS)
                  </button>
                  <button
                    type="button"
                    style={{
                      background: searchMode === 'keyword' ? 'var(--primary)' : 'transparent',
                      color: searchMode === 'keyword' ? '#ffffff' : 'var(--text-secondary)',
                      border: 'none',
                      borderRadius: 'var(--radius-sm)',
                      padding: '0.375rem 0.75rem',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                    onClick={() => setSearchMode('keyword')}
                  >
                    Keyword (FTS)
                  </button>
                </div>

                {/* Option Toggles */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8125rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={useReranker}
                      onChange={(e) => setUseReranker(e.target.checked)}
                      style={{ accentColor: 'var(--primary)', cursor: 'pointer' }}
                    />
                    <span>Cross-Encoder Rerank</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8125rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={useGroundedAnswer}
                      onChange={(e) => setUseGroundedAnswer(e.target.checked)}
                      style={{ accentColor: 'var(--primary)', cursor: 'pointer' }}
                    />
                    <span>Grounded Answer</span>
                  </label>
                </div>
              </div>
            </form>
          </div>

          {/* Grounded Answer Card (When synthesized) */}
          {groundedAnswer && (
            <div
              className="glass-panel"
              style={{
                padding: '1.5rem',
                borderLeft: groundedAnswer.has_sufficient_evidence
                  ? '4px solid var(--accent-emerald)'
                  : '4px solid var(--accent-amber)',
                background: groundedAnswer.has_sufficient_evidence
                  ? 'rgba(16, 185, 129, 0.05)'
                  : 'rgba(245, 158, 11, 0.05)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: groundedAnswer.has_sufficient_evidence ? '#6ee7b7' : '#fcd34d', display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                  <Sparkles size={16} /> Extractive Answer
                </span>
                <span className="badge" style={{ background: 'rgba(255, 255, 255, 0.06)' }}>
                  Relevance signal: {groundedAnswer.evidence_score.toFixed(2)}
                </span>
              </div>

              <p style={{ fontSize: '0.9375rem', lineHeight: '1.6', marginBottom: '1rem', color: 'var(--text-primary)' }}>
                {groundedAnswer.answer}
              </p>

              {/* Citations List */}
              {groundedAnswer.citations.length > 0 && (
                <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>Citations & Verified Source Evidence:</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                    {groundedAnswer.citations.map((cite) => (
                      <div
                        key={cite.citation_id}
                        style={{
                          background: 'rgba(30, 41, 59, 0.8)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: 'var(--radius-sm)',
                          padding: '0.375rem 0.625rem',
                          fontSize: '0.75rem',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                        }}
                      >
                        <span style={{ fontWeight: 700, color: 'var(--primary)' }}>[{cite.citation_id}]</span>
                        <span>{cite.document_name}</span>
                        <span className="badge badge-mode" style={{ fontSize: '0.6875rem' }}>Page {cite.page_number}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Results Summary Bar */}
          {searchLatency !== null && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.8125rem', color: 'var(--text-muted)', padding: '0 0.5rem' }}>
              <span>Found {searchResults.length} relevant candidate passages</span>
              <span>Retrieved in {searchLatency} ms</span>
            </div>
          )}

          {/* Ranked Passages List */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {searchResults.map((result, idx) => (
              <div key={result.chunk_id || idx} className="glass-panel" style={{ padding: '1.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.8125rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                      #{idx + 1} {result.document_name}
                    </span>
                    <span className="badge badge-mode" style={{ fontSize: '0.6875rem' }}>
                      Page {result.page_number}
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    {result.details?.reranker_score !== undefined && (
                      <span className="badge" style={{ background: 'rgba(139, 92, 246, 0.15)', color: '#c4b5fd' }}>
                        Cross-Encoder: {(result.details.reranker_score * 100).toFixed(0)}%
                      </span>
                    )}
                    <span className="badge" style={{ background: 'rgba(99, 102, 241, 0.15)', color: '#a5b4fc' }}>
                      Score: {result.score.toFixed(4)}
                    </span>
                  </div>
                </div>

                <p style={{ fontSize: '0.875rem', lineHeight: '1.6', color: 'var(--text-secondary)', background: 'rgba(15, 23, 42, 0.5)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(255, 255, 255, 0.04)' }}>
                  {result.content}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Auth Modal */}
      {showAuthModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
          onClick={() => setShowAuthModal(false)}
        >
          <div
            className="glass-panel"
            style={{ width: '100%', maxWidth: '400px', padding: '2rem', background: 'var(--bg-secondary)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ fontSize: '1.25rem', fontWeight: 800, marginBottom: '0.5rem' }}>
              {authMode === 'login' ? 'Sign In to DocSearch' : 'Create an Account'}
            </h2>
            <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
              Multi-user isolation and ownership protection
            </p>

            <form onSubmit={handleAuth} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ fontSize: '0.8125rem', fontWeight: 600, display: 'block', marginBottom: '0.375rem' }}>
                  Email Address
                </label>
                <input
                  type="email"
                  required
                  className="input-field"
                  placeholder="engineer@docsearch.local"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                />
              </div>

              <div>
                <label style={{ fontSize: '0.8125rem', fontWeight: 600, display: 'block', marginBottom: '0.375rem' }}>
                  Password
                </label>
                <input
                  type="password"
                  required
                  className="input-field"
                  placeholder="••••••••"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                />
              </div>

              {authError && (
                <div style={{ padding: '0.5rem', background: 'rgba(244, 63, 94, 0.1)', color: '#fda4af', borderRadius: 'var(--radius-sm)', fontSize: '0.75rem' }}>
                  {authError}
                </div>
              )}

              <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '0.5rem' }}>
                {authMode === 'login' ? 'Sign In' : 'Register'}
              </button>

              <div style={{ textAlign: 'center', marginTop: '0.5rem', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                {authMode === 'login' ? (
                  <span>
                    Don't have an account?{' '}
                    <button
                      type="button"
                      style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontWeight: 600 }}
                      onClick={() => setAuthMode('register')}
                    >
                      Register
                    </button>
                  </span>
                ) : (
                  <span>
                    Already have an account?{' '}
                    <button
                      type="button"
                      style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', fontWeight: 600 }}
                      onClick={() => setAuthMode('login')}
                    >
                      Sign In
                    </button>
                  </span>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
