import React, { useState, useEffect } from 'react';
import { 
  Sun, Moon, Trash2, Copy, Check, Plus, 
  RefreshCw, AlertCircle, Link, Rss, Youtube, 
  MessageSquare, Globe, X, ExternalLink, Settings
} from 'lucide-react';
import { Feed, FeedType, ScrapedFeedItem } from './types.js';

export default function App() {
  // Theme state
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark') return true;
    if (saved === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  // Feeds state
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Modal & Form state
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [name, setName] = useState<string>('');
  const [ttl, setTtl] = useState<number>(15);
  
  interface FormSource {
    id?: string;
    url: string;
    type: FeedType;
    config: any;
    testResult?: { count: number; items: ScrapedFeedItem[] } | null;
    testError?: string | null;
    testing?: boolean;
  }

  const [formSources, setFormSources] = useState<FormSource[]>([
    { url: '', type: 'rss', config: {} }
  ]);
  const [editingFeed, setEditingFeed] = useState<Feed | null>(null);

  const getInitialConfigForType = (type: FeedType) => {
    switch (type) {
      case 'youtube':
        return { includeShorts: true };
      case 'fourchan':
        return { board: 'g', query: '', topN: 10 };
      case 'html':
        return { itemSelector: '', titleSelector: '', linkSelector: '', descriptionSelector: '', pubDateSelector: '' };
      default:
        return {};
    }
  };

  const [copiedFeedId, setCopiedFeedId] = useState<string | null>(null);
  const [refreshingFeedId, setRefreshingFeedId] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);



  // Apply dark mode theme
  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [darkMode]);

  // Listen to system dark/light theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      const saved = localStorage.getItem('theme');
      if (!saved) {
        setDarkMode(e.matches);
      }
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const handleToggleTheme = () => {
    const nextMode = !darkMode;
    setDarkMode(nextMode);
    localStorage.setItem('theme', nextMode ? 'dark' : 'light');
  };

  // Fetch registered feeds
  const fetchFeeds = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/feeds');
      if (!res.ok) throw new Error('Failed to load feeds from server');
      const data = await res.json();
      setFeeds(data);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFeeds();
  }, []);

  // Delete feed
  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this feed? All cached items will be permanently removed.')) {
      return;
    }
    try {
      const res = await fetch(`/api/feeds/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete feed');
      setFeeds(feeds.filter(feed => feed.id !== id));
    } catch (err: any) {
      alert(`Error deleting feed: ${err.message}`);
    }
  };

  // Force Refresh Cache manually
  const handleRefreshFeed = async (id: string) => {
    setRefreshingFeedId(id);
    try {
      const res = await fetch(`/api/feeds/${id}/refresh`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to refresh feed cache');
      await fetchFeeds();
    } catch (err: any) {
      alert(`Error refreshing feed cache: ${err.message}`);
    } finally {
      setRefreshingFeedId(null);
    }
  };

  // Run Real-time Selector Test for a specific source row
  const handleTestSource = async (index: number) => {
    const source = formSources[index];
    if (!source.url && source.type !== 'fourchan') {
      alert('Please enter a URL to test');
      return;
    }

    const updated = [...formSources];
    updated[index] = { ...source, testing: true, testResult: null, testError: null };
    setFormSources(updated);

    let testUrl = source.url;
    let configPayload = source.config;

    if (source.type === 'fourchan') {
      testUrl = `https://boards.4channel.org/${source.config.board}/`;
    }

    try {
      const res = await fetch('/api/feeds/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: source.type,
          url: testUrl,
          config: configPayload,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server testing failed');
      
      const latest = [...formSources];
      latest[index] = { ...source, testing: false, testResult: data, testError: null };
      setFormSources(latest);
    } catch (err: any) {
      const latest = [...formSources];
      latest[index] = { ...source, testing: false, testResult: null, testError: err.message || 'Scraper test failed' };
      setFormSources(latest);
    }
  };

  // Register feed to database or update existing one
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || formSources.some(s => !s.url && s.type !== 'fourchan')) {
      alert('Please fill out all required fields');
      return;
    }

    const payload = {
      name,
      ttl: ttl,
      sources: formSources.map((s) => ({
        id: s.id,
        url: s.type === 'fourchan' ? `https://boards.4channel.org/${s.config.board}/` : s.url,
        type: s.type,
        config: s.config,
      })),
    };

    setSaving(true);
    try {
      const url = editingFeed ? `/api/feeds/${editingFeed.id}` : '/api/feeds';
      const method = editingFeed ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save feed');
      }

      setIsModalOpen(false);
      resetForm();
      fetchFeeds();
    } catch (err: any) {
      alert(`Error saving feed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const resetForm = () => {
    setName('');
    setTtl(15);
    setFormSources([{ url: '', type: 'rss', config: {} }]);
    setEditingFeed(null);
  };

  const handleEditClick = (feed: Feed) => {
    setEditingFeed(feed);
    setName(feed.name);
    setTtl(feed.ttl);
    const mappedSources = feed.sources.map((source) => ({
      id: source.id,
      url: source.url,
      type: source.type,
      config: source.config ? JSON.parse(source.config) : getInitialConfigForType(source.type),
    }));
    setFormSources(mappedSources);
    setIsModalOpen(true);
  };

  // Copy feed link helper
  const handleCopyLink = (feedId: string) => {
    const base = window.location.origin;
    const link = `${base}/feeds/${feedId}`;
    
    navigator.clipboard.writeText(link);
    setCopiedFeedId(feedId);
    setTimeout(() => setCopiedFeedId(null), 2000);
  };

  // Format date helper
  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Badge mapping
  const getBadgeClass = (type: FeedType) => {
    switch (type) {
      case 'rss': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
      case 'youtube': return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
      case 'reddit': return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300';
      case 'fourchan': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
      case 'html': return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300';
    }
  };

  const getPlatformIcon = (type: FeedType) => {
    switch (type) {
      case 'rss': return <Rss className="w-4 h-4 mr-1" />;
      case 'youtube': return <Youtube className="w-4 h-4 mr-1" />;
      case 'reddit': return <Globe className="w-4 h-4 mr-1" />;
      case 'fourchan': return <MessageSquare className="w-4 h-4 mr-1" />;
      case 'html': return <Globe className="w-4 h-4 mr-1" />;
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100 transition-colors duration-200">
      
      {/* HEADER */}
      <header className="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 sticky top-0 z-10 shadow-sm">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="bg-indigo-600 text-white p-2 rounded-lg">
              <Rss className="w-6 h-6" />
            </div>
            <div>
              <h1 className="font-bold text-xl tracking-tight">RSS Aggregator</h1>
              <p className="text-xs text-gray-500 dark:text-gray-400">Custom Feed Configurator</p>
            </div>
          </div>
          <div className="flex items-center space-x-4">
            <button 
              onClick={handleToggleTheme}
              className="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 border border-gray-200 dark:border-gray-800 transition"
              title="Toggle Theme"
            >
              {darkMode ? <Sun className="w-5 h-5 text-amber-500" /> : <Moon className="w-5 h-5 text-indigo-500" />}
            </button>
            <button 
              onClick={() => { resetForm(); setIsModalOpen(true); }}
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium px-4 py-2 rounded-lg shadow-sm flex items-center space-x-1 transition"
            >
              <Plus className="w-5 h-5" />
              <span>Add Feed</span>
            </button>
          </div>
        </div>
      </header>

      {/* MAIN CONTAINER */}
      <main className="max-w-6xl mx-auto px-6 py-8">
        
        {error && (
          <div className="mb-6 bg-red-50 border-l-4 border-red-500 p-4 rounded dark:bg-red-950/20 dark:border-red-900 flex items-start space-x-3">
            <AlertCircle className="w-5 h-5 text-red-500 mt-0.5" />
            <div>
              <h3 className="font-semibold text-red-800 dark:text-red-400">Connection Error</h3>
              <p className="text-sm text-red-700 dark:text-red-500">{error}</p>
            </div>
          </div>
        )}

        {/* FEED TABLE LIST */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden shadow-sm">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
            <h2 className="font-semibold text-lg">Active Feeds</h2>
            <button 
              onClick={fetchFeeds}
              className="p-2 text-gray-500 hover:text-indigo-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition"
              title="Refresh Feeds"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {loading && feeds.length === 0 ? (
            <div className="p-12 text-center text-gray-500">
              <RefreshCw className="w-8 h-8 animate-spin mx-auto mb-3 text-indigo-600" />
              <p>Loading your registered feeds...</p>
            </div>
          ) : feeds.length === 0 ? (
            <div className="p-12 text-center max-w-md mx-auto">
              <Rss className="w-12 h-12 text-gray-300 dark:text-gray-700 mx-auto mb-4" />
              <h3 className="font-semibold text-lg mb-1">No feeds registered</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                Connect standard RSS URLs, subreddits, YouTube channels, or parse custom HTML using selectors.
              </p>
              <button 
                onClick={() => { resetForm(); setIsModalOpen(true); }}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium px-4 py-2 rounded-lg transition"
              >
                Create your first feed
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-900/50 text-xs font-semibold text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800 align-middle">
                    <th className="px-6 py-3 align-middle text-left">Feed Name / Platforms</th>
                    <th className="px-6 py-3 align-middle text-left">Aggregated Sources</th>
                    <th className="px-6 py-3 align-middle text-center">Cache Refresh (TTL)</th>
                    <th className="px-6 py-3 align-middle text-center">Generated RSS Feed URL</th>
                    <th className="px-6 py-3 align-middle text-center">Last Checked</th>
                    <th className="px-6 py-3 text-right align-middle">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-800 text-sm">
                  {feeds.map((feed) => (
                    <tr key={feed.id} className="hover:bg-gray-50/50 dark:hover:bg-gray-900/30 align-middle">
                      <td className="px-6 py-4 font-normal align-middle text-left">
                        <div className="font-semibold text-gray-900 dark:text-white">{feed.name}</div>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {Array.from(new Set(feed.sources.map(s => s.type))).map((type) => (
                            <span key={type} className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold leading-none ${getBadgeClass(type)}`}>
                              {getPlatformIcon(type)}
                              <span className="capitalize">{type === 'fourchan' ? '4chan' : type === 'html' ? 'Custom HTML' : type}</span>
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-6 py-4 align-middle text-left">
                        {feed.sources.length === 0 ? (
                          <span className="text-xs text-gray-400">No sources</span>
                        ) : (
                          <div className="flex items-center space-x-1.5 text-xs text-gray-550 dark:text-gray-400">
                            {getPlatformIcon(feed.sources[0].type)}
                            <a 
                              href={feed.sources[0].url} 
                              target="_blank" 
                              rel="noreferrer" 
                              className="hover:text-indigo-600 inline-flex items-center text-xs truncate max-w-[150px] font-mono text-gray-650 dark:text-gray-400 font-semibold"
                              title={feed.sources[0].url}
                            >
                              <span className="truncate">
                                {(() => {
                                  let displayUrl = feed.sources[0].url;
                                  if (feed.sources[0].type === 'fourchan' && feed.sources[0].config) {
                                    try {
                                      const parsed = JSON.parse(feed.sources[0].config);
                                      displayUrl = `/${parsed.board}/ "${parsed.query}"`;
                                    } catch {}
                                  }
                                  return displayUrl;
                                })()}
                              </span>
                              <ExternalLink className="w-2.5 h-2.5 ml-1 flex-shrink-0 text-gray-400 hover:text-indigo-500" />
                            </a>
                            {feed.sources.length > 1 && (
                              <span className="text-[9px] bg-gray-150 dark:bg-gray-800 text-gray-600 dark:text-gray-300 px-1.5 py-0.5 rounded-full font-bold flex-shrink-0">
                                +{feed.sources.length - 1} more
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4 align-middle text-center text-gray-650 dark:text-gray-350 font-medium">
                        {feed.ttl < 60 ? `${feed.ttl} mins` : `${feed.ttl / 60} hour${feed.ttl / 60 > 1 ? 's' : ''}`}
                      </td>
                      <td className="px-6 py-4 align-middle text-center">
                        <div className="flex items-center space-x-1 bg-gray-50 dark:bg-gray-950 p-1.5 rounded-lg border border-gray-200 dark:border-gray-800 max-w-[260px] mx-auto">
                          <span className="text-xs truncate font-mono text-gray-650 dark:text-gray-450 flex-1">
                            {`${window.location.origin}/feeds/${feed.id}`}
                          </span>
                          <button 
                            onClick={() => handleCopyLink(feed.id)}
                            className="p-1 rounded bg-white hover:bg-gray-100 dark:bg-gray-800 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:text-indigo-600 transition"
                            title="Copy RSS URL"
                          >
                            {copiedFeedId === feed.id ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </td>
                      <td className="px-6 py-4 align-middle text-center text-xs text-gray-500 dark:text-gray-400">
                        {formatDate(feed.lastFetched)}
                      </td>
                      <td className="px-6 py-4 text-right space-x-1 whitespace-nowrap align-middle">
                        <button 
                          onClick={() => handleRefreshFeed(feed.id)}
                          disabled={refreshingFeedId === feed.id}
                          className="p-2 text-gray-405 hover:text-indigo-650 hover:bg-indigo-50 dark:hover:bg-indigo-950/20 rounded-lg transition disabled:opacity-50"
                          title="Force Refresh Cache"
                        >
                          <RefreshCw className={`w-4 h-4 ${refreshingFeedId === feed.id ? 'animate-spin' : ''}`} />
                        </button>
                        <button 
                          onClick={() => handleEditClick(feed)}
                          className="p-2 text-gray-404 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/20 rounded-lg transition"
                          title="Manage Feed & Sources"
                        >
                          <Settings className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => handleDelete(feed.id)}
                          className="p-2 text-gray-404 hover:text-red-650 hover:bg-red-50 dark:hover:bg-red-950/20 rounded-lg transition"
                          title="Delete Feed"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      {/* REGISTER/EDIT FORM MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm overflow-y-auto">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 w-full max-w-2xl rounded-2xl shadow-xl overflow-hidden my-8 flex flex-col max-h-[90vh]">
            
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between bg-gray-50 dark:bg-gray-900/50">
              <div className="flex items-center space-x-2">
                <Plus className="w-5 h-5 text-indigo-600" />
                <h3 className="font-bold text-lg">{editingFeed ? 'Manage Feed & Sources' : 'Register New Feed'}</h3>
              </div>
              <button 
                onClick={() => setIsModalOpen(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-800 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <form onSubmit={handleSubmit} className="p-6 overflow-y-auto flex-1 space-y-5 text-left">
              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1.5">Feed Name</label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. My Developer Feed"
                    className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-gray-500 mb-1.5">Cache TTL</label>
                  <select
                    value={ttl}
                    onChange={(e) => setTtl(parseInt(e.target.value))}
                    className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                  >
                    <option value="5">5 minutes</option>
                    <option value="15">15 minutes</option>
                    <option value="30">30 minutes</option>
                    <option value="60">1 hour</option>
                    <option value="720">12 hours</option>
                  </select>
                </div>
              </div>

              {/* Dynamic Sources Section */}
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-gray-150 dark:border-gray-850 pb-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-gray-500">Aggregate Sources</span>
                  <button
                    type="button"
                    onClick={() => {
                      const lastSource = formSources[0]; // first item (top of list)
                      const lastType = lastSource?.type || 'rss';
                      const lastConfig = lastSource?.config ? { ...lastSource.config } : getInitialConfigForType(lastType);
                      // Clear board details but keep general preferences
                      const newConfig = { ...lastConfig };
                      if (lastType === 'fourchan') {
                        newConfig.query = '';
                      }
                      setFormSources([
                        { url: '', type: lastType, config: newConfig },
                        ...formSources
                      ]);
                    }}
                    className="bg-indigo-50 hover:bg-indigo-100 text-indigo-600 dark:bg-indigo-950/30 dark:text-indigo-400 border border-indigo-200/50 dark:border-indigo-900/50 text-xs font-semibold px-2.5 py-1 rounded-lg flex items-center space-x-1 transition"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Source</span>
                  </button>
                </div>

                <div className="space-y-3 max-h-[45vh] overflow-y-auto pr-1">
                  {formSources.map((source, index) => (
                    <div key={index} className="p-3 bg-gray-50 dark:bg-gray-900/40 rounded-xl border border-gray-200 dark:border-gray-800 relative">
                      {formSources.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setFormSources(formSources.filter((_, i) => i !== index))}
                          className="absolute top-2 right-2 text-gray-400 hover:text-red-500 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-800"
                          title="Remove Source"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}

                      {/* Main row layout based on Type */}
                      {source.type !== 'fourchan' ? (
                        <div className="grid grid-cols-12 gap-3 pr-6 items-end">
                          <div className="col-span-3">
                            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1">Source Type</label>
                            <select
                              value={source.type}
                              onChange={(e) => {
                                const newType = e.target.value as FeedType;
                                const updated = [...formSources];
                                updated[index] = {
                                  ...source,
                                  type: newType,
                                  config: getInitialConfigForType(newType),
                                  url: '',
                                  testResult: null,
                                  testError: null,
                                };
                                setFormSources(updated);
                              }}
                              className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-indigo-500"
                            >
                              <option value="rss">RSS Feed</option>
                              <option value="youtube">YouTube Channel</option>
                              <option value="reddit">Subreddit</option>
                              <option value="html">Custom HTML Scraper</option>
                              <option value="fourchan">4chan Search</option>
                            </select>
                          </div>

                          <div className={source.type === 'youtube' ? 'col-span-5' : 'col-span-7'}>
                            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1">
                              {source.type === 'youtube' ? 'Channel URL or Handle' : source.type === 'reddit' ? 'Subreddit name / URL' : 'Website or RSS Feed URL'}
                            </label>
                            <input
                              type="text"
                              required
                              autoFocus={index === 0 && !source.url && !source.id}
                              value={source.url}
                              onChange={(e) => {
                                const updated = [...formSources];
                                updated[index] = { ...source, url: e.target.value };
                                setFormSources(updated);
                              }}
                              placeholder={
                                source.type === 'youtube' ? 'https://www.youtube.com/@t3dotgg' : 
                                source.type === 'reddit' ? 'r/javascript' : 'https://example.com/blog'
                              }
                              className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-indigo-500"
                            />
                          </div>

                          {source.type === 'youtube' && (
                            <div className="col-span-2 flex items-center justify-center pb-2">
                              <label className="flex items-center cursor-pointer select-none">
                                <input
                                  type="checkbox"
                                  checked={source.config?.includeShorts !== false}
                                  onChange={(e) => {
                                    const updated = [...formSources];
                                    updated[index] = {
                                      ...source,
                                      config: { ...source.config, includeShorts: e.target.checked },
                                    };
                                    setFormSources(updated);
                                  }}
                                  className="rounded border-gray-300 dark:border-gray-700 text-indigo-600 focus:ring-indigo-500 h-3.5 w-3.5"
                                />
                                <span className="ml-1.5 text-xs font-semibold text-gray-650 dark:text-gray-350">Shorts</span>
                              </label>
                            </div>
                          )}

                          <div className="col-span-2 pb-0.5">
                            <button
                              type="button"
                              disabled={source.testing || !source.url}
                              onClick={() => handleTestSource(index)}
                              className="w-full bg-white border border-gray-350 text-gray-650 hover:bg-gray-50 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-300 font-semibold py-1.5 px-2 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed text-xs transition flex items-center justify-center space-x-1"
                            >
                              {source.testing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Link className="w-3.5 h-3.5" />}
                              <span>Test</span>
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="grid grid-cols-12 gap-3 pr-6 items-end">
                          <div className="col-span-3">
                            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1">Source Type</label>
                            <select
                              value={source.type}
                              onChange={(e) => {
                                const newType = e.target.value as FeedType;
                                const updated = [...formSources];
                                updated[index] = {
                                  ...source,
                                  type: newType,
                                  config: getInitialConfigForType(newType),
                                  url: '',
                                  testResult: null,
                                  testError: null,
                                };
                                setFormSources(updated);
                              }}
                              className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-indigo-500"
                            >
                              <option value="rss">RSS Feed</option>
                              <option value="youtube">YouTube Channel</option>
                              <option value="reddit">Subreddit</option>
                              <option value="html">Custom HTML Scraper</option>
                              <option value="fourchan">4chan Search</option>
                            </select>
                          </div>

                          <div className="col-span-2">
                            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1">Board</label>
                            <input
                              type="text"
                              required
                              autoFocus={index === 0 && !source.id && (!source.config?.board || source.config?.board === 'g')}
                              value={source.config?.board || ''}
                              onChange={(e) => {
                                const updated = [...formSources];
                                updated[index] = {
                                  ...source,
                                  config: { ...source.config, board: e.target.value.toLowerCase().trim() },
                                };
                                setFormSources(updated);
                              }}
                              placeholder="g, v, a"
                              className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-indigo-500"
                            />
                          </div>

                          <div className="col-span-3">
                            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1">Search Query</label>
                            <input
                              type="text"
                              required
                              value={source.config?.query || ''}
                              onChange={(e) => {
                                const updated = [...formSources];
                                updated[index] = {
                                  ...source,
                                  config: { ...source.config, query: e.target.value },
                                };
                                setFormSources(updated);
                              }}
                              placeholder="setup, linux"
                              className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-indigo-500"
                            />
                          </div>

                          <div className="col-span-2">
                            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1">Max Threads</label>
                            <input
                              type="number"
                              min="1"
                              max="50"
                              value={source.config?.topN || 10}
                              onChange={(e) => {
                                const updated = [...formSources];
                                updated[index] = {
                                  ...source,
                                  config: { ...source.config, topN: parseInt(e.target.value) || 10 },
                                };
                                setFormSources(updated);
                              }}
                              className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-indigo-500"
                            />
                          </div>

                          <div className="col-span-2 pb-0.5">
                            <button
                              type="button"
                              disabled={source.testing}
                              onClick={() => handleTestSource(index)}
                              className="w-full bg-white border border-gray-350 text-gray-650 hover:bg-gray-50 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-300 font-semibold py-1.5 px-2 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed text-xs transition flex items-center justify-center space-x-1"
                            >
                              {source.testing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Link className="w-3.5 h-3.5" />}
                              <span>Test</span>
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Compact Selector Inputs for Custom HTML */}
                      {source.type === 'html' && (
                        <div className="grid grid-cols-5 gap-2 mt-2 bg-white dark:bg-gray-900/60 p-2.5 rounded-lg border border-gray-200 dark:border-gray-800">
                          <div>
                            <label className="block text-[9px] font-semibold text-gray-500 mb-0.5">Container CSS *</label>
                            <input
                              type="text"
                              required
                              value={source.config?.itemSelector || ''}
                              onChange={(e) => {
                                const updated = [...formSources];
                                updated[index] = {
                                  ...source,
                                  config: { ...source.config, itemSelector: e.target.value },
                                };
                                setFormSources(updated);
                              }}
                              placeholder=".post-item"
                              className="w-full bg-white dark:bg-gray-800 border border-gray-250 dark:border-gray-700 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-indigo-500"
                            />
                          </div>
                          <div>
                            <label className="block text-[9px] font-semibold text-gray-500 mb-0.5">Title CSS *</label>
                            <input
                              type="text"
                              required
                              value={source.config?.titleSelector || ''}
                              onChange={(e) => {
                                const updated = [...formSources];
                                updated[index] = {
                                  ...source,
                                  config: { ...source.config, titleSelector: e.target.value },
                                };
                                setFormSources(updated);
                              }}
                              placeholder="h2"
                              className="w-full bg-white dark:bg-gray-800 border border-gray-255 dark:border-gray-700 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-indigo-500"
                            />
                          </div>
                          <div>
                            <label className="block text-[9px] font-semibold text-gray-500 mb-0.5">Link CSS *</label>
                            <input
                              type="text"
                              required
                              value={source.config?.linkSelector || ''}
                              onChange={(e) => {
                                const updated = [...formSources];
                                updated[index] = {
                                  ...source,
                                  config: { ...source.config, linkSelector: e.target.value },
                                };
                                setFormSources(updated);
                              }}
                              placeholder="a"
                              className="w-full bg-white dark:bg-gray-800 border border-gray-255 dark:border-gray-700 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-indigo-500"
                            />
                          </div>
                          <div>
                            <label className="block text-[9px] font-semibold text-gray-500 mb-0.5">Desc CSS</label>
                            <input
                              type="text"
                              value={source.config?.descriptionSelector || ''}
                              onChange={(e) => {
                                const updated = [...formSources];
                                updated[index] = {
                                  ...source,
                                  config: { ...source.config, descriptionSelector: e.target.value },
                                };
                                setFormSources(updated);
                              }}
                              placeholder=".summary"
                              className="w-full bg-white dark:bg-gray-800 border border-gray-255 dark:border-gray-700 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-indigo-500"
                            />
                          </div>
                          <div>
                            <label className="block text-[9px] font-semibold text-gray-500 mb-0.5">Date CSS</label>
                            <input
                              type="text"
                              value={source.config?.pubDateSelector || ''}
                              onChange={(e) => {
                                const updated = [...formSources];
                                updated[index] = {
                                  ...source,
                                  config: { ...source.config, pubDateSelector: e.target.value },
                                };
                                setFormSources(updated);
                              }}
                              placeholder="span.date"
                              className="w-full bg-white dark:bg-gray-805 border border-gray-250 dark:border-gray-700 rounded px-2 py-1 text-[11px] focus:outline-none focus:border-indigo-500"
                            />
                          </div>
                        </div>
                      )}

                      {/* inline feedback blocks */}
                      {source.testError && (
                        <div className="bg-red-50 text-red-800 border border-red-200 p-2 rounded-lg text-[10px] dark:bg-red-950/20 dark:border-red-900/60 dark:text-red-400 mt-2">
                          {source.testError}
                        </div>
                      )}

                      {source.testResult && (
                        <div className="border border-green-200 dark:border-green-900 bg-green-50/20 dark:bg-green-950/5 p-2 rounded-lg text-[10px] max-h-24 overflow-y-auto mt-2">
                          <span className="font-bold text-green-700 dark:text-green-400 block mb-1">
                            Success! Found {source.testResult.count} items:
                          </span>
                          <ul className="list-disc pl-4 space-y-0.5 text-gray-500">
                            {source.testResult.items.slice(0, 3).map((item, i) => (
                              <li key={i} className="truncate">{item.title}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Modal Footer */}
              <div className="border-t border-gray-200 dark:border-gray-800 pt-4 flex justify-end space-x-3 bg-gray-50 dark:bg-gray-900/50 -mx-6 -mb-6 px-6 py-4 mt-6">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 font-semibold text-sm rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-sm rounded-lg shadow-sm transition disabled:opacity-50 flex items-center space-x-1.5"
                >
                  {saving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                  <span>{saving ? (editingFeed ? 'Saving...' : 'Registering...') : (editingFeed ? 'Save Changes' : 'Register Feed')}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
