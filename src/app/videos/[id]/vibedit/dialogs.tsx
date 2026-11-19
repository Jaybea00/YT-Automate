'use client';

import React from 'react';
import { SHORTCUTS } from './shortcuts';

/** Vibedit's pop-up dialogs: the keyboard shortcuts, and how to switch on AI video. */

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => onClose()}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-5 w-full max-w-md space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-white">⌨️ Keyboard shortcuts</h2>
          <button onClick={() => onClose()} className="text-zinc-400 hover:text-white text-sm">✕</button>
        </div>
        <table className="w-full text-xs">
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.keys} className="border-t border-zinc-800">
                <td className="py-1.5 pr-3 font-mono text-indigo-300 whitespace-nowrap">{s.keys}</td>
                <td className="py-1.5 text-zinc-300">{s.does}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[11px] text-zinc-500">They don&apos;t fire while you type in a box.</p>
      </div>
    </div>
  );
}

export function AiVideoKeyDialog({ message, onClose }: { message: string; onClose: () => void }) {
  const keyModalMessage = message;
  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <span>🎬</span> Activate AI Video Generation
          </h3>
          <button
            type="button"
            onClick={() => onClose()}
            className="text-zinc-400 hover:text-white cursor-pointer"
          >
            ✕
          </button>
        </div>
        <p className="text-xs text-zinc-300 leading-relaxed">
          {keyModalMessage}
        </p>

        <div className="space-y-3 pt-1">
          <div>
            <span className="text-[11px] font-semibold text-emerald-400 block mb-1">
              Option 1: Direct Google Veo API Key (Google AI Studio / Vertex AI)
            </span>
            <div className="bg-black/60 rounded-xl p-2.5 border border-zinc-800 font-mono text-[11px] text-emerald-300 select-all">
              GOOGLE_VEO_API_KEY=your_google_key_here
            </div>
            <p className="text-[10px] text-zinc-400 mt-1">
              Works directly with your key from <a href="https://aistudio.google.com" target="_blank" rel="noreferrer" className="text-indigo-400 underline">Google AI Studio</a> (or GEMINI_API_KEY).
            </p>
          </div>

          <div>
            <span className="text-[11px] font-semibold text-pink-400 block mb-1">
              Option 2: Fal.ai Gateway (Veo 2, Kling, MiniMax)
            </span>
            <div className="bg-black/60 rounded-xl p-2.5 border border-zinc-800 font-mono text-[11px] text-pink-300 select-all">
              FAL_KEY=your_fal_api_key_here
            </div>
            <p className="text-[10px] text-zinc-400 mt-1">
              Provides access via <a href="https://fal.ai" target="_blank" rel="noreferrer" className="text-indigo-400 underline">fal.ai</a> for multiple video foundation models.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => onClose()}
          className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-bold text-white cursor-pointer transition mt-2"
        >
          Got it!
        </button>
      </div>
    </div>
  );
}
