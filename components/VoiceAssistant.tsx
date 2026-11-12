"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useAdminToken } from "./AdminToken";

type Citation = {
  source: string;
  external_id: string;
  title: string;
  chunk_index: number;
  score: number;
};

type ApprovalItem = {
  id: string;
  action: string;
  requested_by: string;
  project_name: string | null;
  reason: string | null;
  risk_level: string;
  status?: string;
  action_type?: string | null;
};

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  sources?: string[];
  approvals?: ApprovalItem[];
};

type PendingConfirmation = {
  approval: ApprovalItem;
  decision: "approved" | "rejected";
};

/**
 * Voice assistant (Phase 1): a floating panel on every signed-in page that
 * talks to the owner by voice and text. It owns no backend of its own:
 *  - Commands and status questions go to POST /api/command, which answers
 *    from CompanyOS state and creates tasks through the existing agent
 *    pipeline (the assistant itself never writes anything directly).
 *  - When the command router reports it did not understand (route "help"),
 *    the text falls back to the Ask CompanyOS job flow (POST /api/ask,
 *    then poll GET /api/ask?jobId=...) for a grounded answer with sources.
 *  - Approvals are read from GET /api/approvals and decided through the
 *    same endpoint the Approvals UI uses — behind the strict spoken
 *    confirmation gate described at APPROVE_CONFIRMATIONS below.
 * Voice input uses the browser SpeechRecognition API and replies are
 * spoken with speechSynthesis; both degrade gracefully — no mic API means
 * no mic button, and the panel still works as a plain text chat.
 */

// The knowledge service answers from a local CPU model (15–30s typical),
// so Ask runs as a background job exactly like the Overview panel: start
// it, then poll — no request is held open long enough to be cut off.
const POLL_INTERVAL_MS = 3000;
const POLL_DEADLINE_MS = 6 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollForAnswer(jobId: string): Promise<{ answer: string; citations: Citation[] }> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const result = await fetch(`/api/ask?jobId=${encodeURIComponent(jobId)}`);
    const data = await result.json();
    if (!result.ok) {
      throw new Error(data.error ?? "The knowledge service is not available right now.");
    }
    if (data.status === "done") {
      return {
        answer: typeof data.answer === "string" ? data.answer : "",
        citations: Array.isArray(data.citations) ? data.citations : [],
      };
    }
  }
  throw new Error("Still thinking — the service is unusually slow right now. Try again in a moment.");
}

// ---------------------------------------------------------------------------
// Voice approvals: the confirmation gate.
//
// Approving or rejecting from the assistant is deliberately two-step. A
// decision request ("approve the first one") only ARMS a confirmation: the
// panel displays and speaks exactly what would be decided and waits. The
// decision is sent only when the next reply is one of the explicit phrases
// below. A bare "yes", "yeah", "ok", or "uh-huh" is NEVER a confirmation —
// like any other reply, it cancels the armed confirmation instead. The
// gate applies to typed input exactly as it does to voice.
// ---------------------------------------------------------------------------

const APPROVE_CONFIRMATIONS = new Set(["yes approve it", "yes approve", "confirm approval", "yes confirm approval"]);
const REJECT_CONFIRMATIONS = new Set(["yes reject it", "yes reject", "confirm rejection", "yes confirm rejection"]);

function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:'"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isApprovalListRequest(text: string): boolean {
  const normalized = normalizePhrase(text);
  if (!normalized.includes("approval")) return false;
  return /^(what|read|show|list|check|tell me|give me|any|do i have)\b/.test(normalized) || normalized.includes("my approval") || normalized.includes("waiting");
}

function decisionIntent(text: string): "approved" | "rejected" | null {
  const normalized = normalizePhrase(text);
  if (/\bapprove[sd]?\b/.test(normalized)) return "approved";
  if (/\breject[sd]?\b/.test(normalized) || /\bdeny\b/.test(normalized) || /\bdecline[sd]?\b/.test(normalized)) return "rejected";
  return null;
}

const ORDINALS: Record<string, number> = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4 };

function pickApproval(text: string, items: ApprovalItem[]): ApprovalItem | null {
  const normalized = normalizePhrase(text);
  for (const [word, index] of Object.entries(ORDINALS)) {
    if (new RegExp(`\\b${word}\\b`).test(normalized) && items[index]) return items[index];
  }
  if (/\blast\b/.test(normalized) && items.length > 0) return items[items.length - 1];
  const byTitle = items.filter((item) => normalized.includes(normalizePhrase(item.action)));
  if (byTitle.length === 1) return byTitle[0];
  // Word-overlap fallback: the item whose distinctive words appear most.
  let best: ApprovalItem | null = null;
  let bestScore = 0;
  let tied = false;
  for (const item of items) {
    const words = normalizePhrase(item.action).split(" ").filter((word) => word.length >= 4);
    const score = words.filter((word) => normalized.includes(word)).length;
    if (score > bestScore) {
      best = item;
      bestScore = score;
      tied = false;
    } else if (score === bestScore && score > 0) {
      tied = true;
    }
  }
  if (best && bestScore >= 2 && !tied) return best;
  if (items.length === 1) return items[0];
  return null;
}

function describeApproval(item: ApprovalItem): string {
  return `"${item.action}" — proposed by ${item.requested_by}${item.project_name ? ` for ${item.project_name}` : ""}${item.reason ? `. Details: ${item.reason}` : ""}`;
}

// Minimal structural types for the Web Speech API: TypeScript's DOM lib
// does not ship SpeechRecognition, and no dependency is added for it.
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const speechWindow = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

const GREETING =
  "Hi — ask me a question about the business, check status (\"What needs my attention?\"), ask what's waiting for your approval, or give me a task (\"Create task for Engineer: update the landing page\"). Tap the mic to talk hands-free.";

export function VoiceAssistant() {
  const pathname = usePathname();
  const { token: adminToken } = useAdminToken();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Array<ChatMessage & { id: number }>>([{ id: 0, role: "assistant", text: GREETING }]);
  const messageIdRef = useRef(0);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [listening, setListening] = useState(false);
  const [micSupported, setMicSupported] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Mic support can only be known on the client after mount.
  useEffect(() => {
    setMicSupported(recognitionCtor() !== null);
  }, []);

  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((seconds) => seconds + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  // Keep the newest message in view after every render.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  });

  function appendMessage(message: ChatMessage) {
    messageIdRef.current += 1;
    const id = messageIdRef.current;
    setMessages((previous) => [...previous, { ...message, id }]);
  }

  // Stop any in-flight recognition or speech when the panel unmounts.
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, []);

  function speak(text: string) {
    if (!voiceOn || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  function stopListening() {
    recognitionRef.current?.stop();
    setListening(false);
  }

  function authHeaders(): Record<string, string> {
    return adminToken ? { Authorization: `Bearer ${adminToken}` } : {};
  }

  async function fetchApprovals(): Promise<ApprovalItem[]> {
    const response = await fetch("/api/approvals", { headers: authHeaders(), cache: "no-store" });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error ?? "Approvals are not available right now.");
    }
    const items: ApprovalItem[] = Array.isArray(data.approvals) ? data.approvals : [];
    return items.filter((item) => !item.status || item.status === "pending");
  }

  async function listApprovalsReply(): Promise<ChatMessage> {
    const items = await fetchApprovals();
    if (items.length === 0) {
      return { role: "assistant", text: "Nothing is waiting for your approval right now." };
    }
    const summaries = items.map((item, index) => `${index + 1}. ${item.action}, proposed by ${item.requested_by}`).join(" ");
    const text =
      items.length === 1
        ? `One approval is waiting. ${summaries} Say "approve it" or "reject it" and I will read it back for your explicit confirmation before deciding anything.`
        : `${items.length} approvals are waiting. ${summaries} Tell me which one to approve or reject — I will read it back for your explicit confirmation before deciding anything.`;
    return { role: "assistant", text, approvals: items };
  }

  async function beginConfirmationReply(text: string, decision: "approved" | "rejected"): Promise<ChatMessage> {
    // Always re-read the pending list before arming a decision on it.
    const items = await fetchApprovals();
    if (items.length === 0) {
      return { role: "assistant", text: "Nothing is waiting for your approval right now, so there is nothing to decide." };
    }
    const target = pickApproval(text, items);
    if (!target) {
      const summaries = items.map((item, index) => `${index + 1}. ${item.action}, proposed by ${item.requested_by}`).join(" ");
      return {
        role: "assistant",
        text: `I need to know which one you mean. ${summaries} Say "approve the first one" or name the item — I will read it back before anything is decided.`,
        approvals: items,
      };
    }
    setConfirmation({ approval: target, decision });
    const verb = decision === "approved" ? "approve" : "reject";
    return {
      role: "assistant",
      text: `Confirm this decision. You asked me to ${verb}: ${describeApproval(target)}. Nothing is decided yet — to go ahead, say exactly "yes, ${verb} it". Any other reply cancels.`,
      approvals: [target],
    };
  }

  // The only path that records a decision. It runs solely from the armed
  // confirmation state, and only on an explicit confirmation phrase.
  async function handleConfirmationReply(text: string): Promise<ChatMessage> {
    const armed = confirmation as PendingConfirmation;
    setConfirmation(null);
    const phrase = normalizePhrase(text);
    const phrases = armed.decision === "approved" ? APPROVE_CONFIRMATIONS : REJECT_CONFIRMATIONS;
    const verb = armed.decision === "approved" ? "approve" : "reject";
    if (!phrases.has(phrase)) {
      return {
        role: "assistant",
        text: `Cancelled — nothing was decided. "${armed.approval.action}" is still waiting. Approving or rejecting here always needs the explicit phrase, like "yes, ${verb} it", after I read the item back.`,
      };
    }
    const response = await fetch("/api/approvals", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ id: armed.approval.id, status: armed.decision }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error ?? "Unable to record that decision.");
    }
    return {
      role: "assistant",
      text: `${armed.decision === "approved" ? "Approved" : "Rejected"}: "${armed.approval.action}", proposed by ${armed.approval.requested_by}. The decision is recorded, and execution now flows through the existing CompanyOS pipeline.`,
    };
  }

  async function routeMessage(text: string): Promise<ChatMessage> {
    // Approvals have their own read path, ahead of the command router.
    if (isApprovalListRequest(text)) return listApprovalsReply();
    const decision = decisionIntent(text);
    if (decision) return beginConfirmationReply(text, decision);

    // 1) The command router: it answers status questions (attention,
    // projects, health, finance…) and creates tasks that run through the
    // owner-approval agent pipeline. Its own reply wording is used as-is,
    // so a created task is reported exactly as the router states it.
    try {
      const result = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: text }),
      });
      const data = await result.json();
      if (result.ok && data.route !== "help" && typeof data.message === "string") {
        return { role: "assistant", text: data.message };
      }
    } catch {
      // A failed command call falls through to the knowledge service.
    }

    // 2) Fallback: the router did not understand, so treat the text as a
    // question for the Ask CompanyOS knowledge service (start + poll).
    const started = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: text }),
    });
    const startData = await started.json();
    if (!started.ok) {
      throw new Error(startData.error ?? "The assistant is not available right now.");
    }
    const { answer, citations } = await pollForAnswer(String(startData.jobId ?? ""));
    const sources = [...new Set(citations.map((citation) => citation.title || citation.source).filter(Boolean))];
    return {
      role: "assistant",
      text: answer || "I could not find an answer in the company knowledge yet.",
      sources,
    };
  }

  async function send(rawText: string) {
    const text = rawText.trim();
    if (!text || busy) return;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    stopListening();
    setInput("");
    appendMessage({ role: "user", text });
    setBusy(true);
    try {
      // An armed confirmation consumes the next reply entirely: it either
      // confirms with the explicit phrase or cancels — it is never routed
      // onward to the command router or the knowledge service.
      const reply = confirmation ? await handleConfirmationReply(text) : await routeMessage(text);
      appendMessage(reply);
      speak(reply.text);
    } catch (error) {
      const reply: ChatMessage = {
        role: "assistant",
        text: error instanceof Error ? error.message : "The assistant is not available right now.",
      };
      appendMessage(reply);
      speak(reply.text);
    } finally {
      setBusy(false);
    }
  }

  function toggleListening() {
    if (listening) {
      stopListening();
      return;
    }
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      let interim = "";
      let finalText = "";
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (finalText.trim()) {
        // A finished utterance sends itself — that is the hands-free loop.
        if (busy) setInput(finalText.trim());
        else void send(finalText);
      } else if (interim) {
        setInput(interim);
      }
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }

  function toggleVoice() {
    if (voiceOn && "speechSynthesis" in window) window.speechSynthesis.cancel();
    setVoiceOn((previous) => !previous);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void send(input);
  }

  // The sign-in page has no owner session to answer for; like the command
  // bar, the assistant only appears on authenticated pages.
  if (pathname === "/login") return null;

  return (
    <>
      {open ? (
        <section className="voice-panel" role="dialog" aria-label="CompanyOS voice assistant">
          <div className="voice-panel-head">
            <div>
              <div className="voice-panel-title">CompanyOS Assistant</div>
              <div className="voice-panel-sub">Questions, status, tasks, and approvals — decisions always confirmed out loud first</div>
            </div>
            <div className="voice-head-actions">
              <button
                type="button"
                className="voice-icon-button"
                onClick={toggleVoice}
                aria-pressed={voiceOn}
                aria-label={voiceOn ? "Mute spoken replies" : "Unmute spoken replies"}
                title={voiceOn ? "Spoken replies on" : "Spoken replies off"}
              >
                {voiceOn ? "🔊" : "🔇"}
              </button>
              <button type="button" className="voice-icon-button" onClick={() => setOpen(false)} aria-label="Close assistant">
                ✕
              </button>
            </div>
          </div>
          <div className="voice-messages" ref={listRef}>
            {messages.map((message) => (
              <div key={message.id} className={message.role === "user" ? "voice-msg voice-msg-user" : "voice-msg voice-msg-assistant"}>
                {message.text}
                {message.approvals?.length ? (
                  <div className="voice-approval-list">
                    {message.approvals.map((item) => (
                      <div className="voice-approval-item" key={item.id}>
                        <strong>{item.action}</strong>
                        <div className="voice-approval-meta">
                          {item.requested_by}
                          {item.project_name ? ` · ${item.project_name}` : ""} · {item.risk_level} risk
                        </div>
                        {item.reason ? <div className="voice-approval-meta">{item.reason}</div> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
                {message.sources?.length ? <div className="voice-sources">Sources: {message.sources.join(" · ")}</div> : null}
              </div>
            ))}
          </div>
          {confirmation ? (
            <div className="voice-confirm" role="alert">
              Waiting for confirmation: {confirmation.decision === "approved" ? "approve" : "reject"} “{confirmation.approval.action}” (proposed by{" "}
              {confirmation.approval.requested_by}). Say “yes, {confirmation.decision === "approved" ? "approve" : "reject"} it” to confirm — anything else cancels.
            </div>
          ) : null}
          {busy ? (
            <div className="voice-status">Working… {elapsed}s — knowledge answers from the local model can take a little while.</div>
          ) : listening ? (
            <div className="voice-status">Listening… speak now.</div>
          ) : null}
          <form onSubmit={submit} className="voice-form">
            {micSupported ? (
              <button
                type="button"
                className={listening ? "voice-mic listening" : "voice-mic"}
                onClick={toggleListening}
                aria-pressed={listening}
                aria-label={listening ? "Stop listening" : "Start voice input"}
                title={listening ? "Stop listening" : "Talk to the assistant"}
              >
                🎤
              </button>
            ) : null}
            <input
              aria-label="Message the CompanyOS assistant"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={micSupported ? "Type or tap the mic…" : "Type a question or command…"}
              disabled={busy}
            />
            <button type="submit" className="voice-send" disabled={busy}>
              {busy ? "…" : "Send"}
            </button>
          </form>
        </section>
      ) : null}
      <button
        type="button"
        className={listening ? "voice-launcher listening" : "voice-launcher"}
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        aria-label={open ? "Close the CompanyOS assistant" : "Open the CompanyOS assistant"}
        title="CompanyOS assistant — ask by voice or text"
      >
        {open ? "✕" : "🎤"}
      </button>
    </>
  );
}
