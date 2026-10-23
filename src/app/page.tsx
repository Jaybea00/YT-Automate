'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { VideoRecord } from '@/lib/types/video';

export default function PipelineDashboard() {
  const [videos, setVideos] = useState<VideoRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadVideos() {
      try {
        const res = await fetch('/api/videos');
        if (!res.ok) {
          throw new Error('Failed to fetch videos.');
        }
        const data = await res.json();
        setVideos(Array.isArray(data) ? data : []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }
    loadVideos();
  }, []);

  const getStatusBadge = (status: VideoRecord['status']) => {
    switch (status) {
      case 'script_review':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/10 border border-amber-500/20 text-amber-400">
            Review Needed
          </span>
        );
      case 'voicing':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
            Approved (Voicing)
          </span>
        );
      case 'scripting':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-500/10 border border-blue-500/20 text-blue-400 animate-pulse">
            Generating Script
          </span>
        );
      case 'failed':
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-red-500/10 border border-red-500/20 text-red-400">
            Failed
          </span>
        );
      default:
        return (
          <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-zinc-800 text-zinc-300">
            {status}
          </span>
        );
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-6 border-b border-zinc-800">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
              <span className="text-xs font-bold tracking-wider text-red-400 uppercase">
                Autonomous Studio
              </span>
            </div>
            <h1 className="text-3xl font-extrabold text-white tracking-tight">
              YouTube Automation Pipeline
            </h1>
            <p className="text-sm text-zinc-400 mt-1">
              Script generation, AI review, and multi-stage production workflow.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Link
              href="/narrators"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-zinc-200 font-semibold text-sm transition cursor-pointer"
            >
              <span>🎙️ Narrator Voices</span>
            </Link>
            <Link
              href="/library"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-zinc-200 font-semibold text-sm transition cursor-pointer"
            >
              <span>🎞️ Clip Library</span>
            </Link>
            <Link
              href="/overnight"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 text-zinc-200 font-semibold text-sm transition cursor-pointer"
            >
              <span>🌙 Overnight</span>
            </Link>
            <Link
              href="/videos/new"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 active:bg-red-700 text-white font-semibold text-sm shadow-lg shadow-red-600/20 transition cursor-pointer"
            >
              <span>+ New Video</span>
            </Link>
          </div>
        </div>

        {/* Video List */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">Pipeline Videos</h2>
            <span className="text-xs text-zinc-400">
              {videos.length} {videos.length === 1 ? 'project' : 'projects'}
            </span>
          </div>

          {loading ? (
            <div className="p-12 text-center bg-zinc-900 border border-zinc-800 rounded-2xl">
              <div className="w-8 h-8 border-3 border-zinc-700 border-t-red-500 rounded-full animate-spin mx-auto mb-3" />
              <p className="text-xs text-zinc-400">Loading videos from database...</p>
            </div>
          ) : error ? (
            <div className="p-6 bg-zinc-900 border border-zinc-800 rounded-2xl text-center space-y-2">
              <p className="text-sm text-zinc-400">
                Could not load videos. Make sure Supabase environment variables are configured.
              </p>
              <div className="pt-2">
                <Link
                  href="/videos/new"
                  className="inline-block px-4 py-2 rounded-xl bg-red-600 text-white text-xs font-semibold"
                >
                  Create Your First Video
                </Link>
              </div>
            </div>
          ) : videos.length === 0 ? (
            <div className="p-12 text-center bg-zinc-900 border border-zinc-800 rounded-2xl space-y-4">
              <div className="w-12 h-12 rounded-full bg-zinc-800 text-zinc-400 mx-auto flex items-center justify-center text-xl">
                🎬
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-bold text-white">No videos created yet</h3>
                <p className="text-xs text-zinc-400 max-w-sm mx-auto">
                  Start your pipeline by generating your first structured script with Claude.
                </p>
              </div>
              <div>
                <Link
                  href="/videos/new"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-semibold text-xs transition"
                >
                  Create New Video Script
                </Link>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {videos.map((vid) => (
                <Link
                  key={vid.id}
                  href={`/videos/${vid.id}/review`}
                  className="p-5 rounded-2xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/80 transition flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 group"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-zinc-500">
                        {vid.id.slice(0, 8)}...
                      </span>
                      {getStatusBadge(vid.status)}
                    </div>
                    <h3 className="text-base font-bold text-white group-hover:text-red-400 transition">
                      {vid.title || vid.topic}
                    </h3>
                    <div className="flex items-center gap-3 text-xs text-zinc-400">
                      <span>Style: <strong className="text-zinc-300 uppercase">{vid.style}</strong></span>
                      <span>•</span>
                      <span>Target: {vid.target_minutes}m</span>
                      {vid.created_at && (
                        <>
                          <span>•</span>
                          <span>{new Date(vid.created_at).toLocaleDateString()}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-xs font-semibold text-zinc-400 group-hover:text-zinc-200">
                    <span>Review Script</span>
                    <svg
                      className="w-4 h-4 transition-transform group-hover:translate-x-1"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
