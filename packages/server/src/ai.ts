import {Queue} from '@aiverse/core';

export type AITaskKind = 'review' | 'commit-msg' | 'resolve' | 'ask';
export type AITaskState = 'pending' | 'processing' | 'ready' | 'error';

export interface AITask {
  id: string;
  kind: AITaskKind;
  input: string;
  state: AITaskState;
  attempts: number;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AIProvider { run(kind: AITaskKind, input: string): Promise<string>; }

export class HeuristicAIProvider implements AIProvider {
  async run(kind: AITaskKind, input: string): Promise<string> {
    if (kind === 'ask') return 'La IA externa no está configurada. Pide al administrador que habilite un proveedor para conversar sobre tu código.';
    if (kind === 'commit-msg') {
      const changed = input.match(/^diff --/gm)?.length ?? 0;
      return changed > 0 ? `Actualiza ${changed} archivo${changed === 1 ? '' : 's'}` : 'Actualiza el proyecto';
    }
    if (kind === 'resolve') return 'Revisa ambos lados del conflicto, conserva el comportamiento compatible y elimina los marcadores antes de confirmar.';
    const findings: string[] = [];
    if (/\bTODO\b/.test(input)) findings.push('Hay tareas TODO pendientes en el cambio.');
    if (/console\.log\(/.test(input)) findings.push('Revisa los console.log antes de confirmar.');
    if (/catch\s*\{\s*\}/.test(input)) findings.push('Hay errores capturados sin manejo ni registro.');
    return findings.length > 0
      ? findings.map((finding, index) => `${index + 1}. ${finding}`).join('\n')
      : 'No se detectaron patrones de riesgo evidentes. Conviene validar casos límite y rutas de error.';
  }
}

export class OpenAIProvider implements AIProvider {
  constructor(private readonly apiKey: string, private readonly model: string) {}
  async run(kind: AITaskKind, input: string): Promise<string> {
    const instructions: Record<AITaskKind, string> = {
      review: 'Revisa este diff. Devuelve hallazgos concretos, priorizados y breves en español.',
      'commit-msg': 'Escribe un mensaje de commit imperativo, claro y de máximo 72 caracteres.',
      resolve: 'Propón una resolución segura para estos conflictos. Explica qué líneas conservar.',
      ask: 'Eres el asistente de AIVerse. Responde en español, explica con claridad, usa el contexto de código proporcionado, sugiere siguientes pasos concretos y nunca afirmes que modificaste archivos.',
    };
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({model: this.model, messages: [{role: 'system', content: instructions[kind]}, {role: 'user', content: input}]}),
    });
    if (!response.ok) throw new Error(`AI provider responded with ${response.status}`);
    const data = await response.json() as {choices?: Array<{message?: {content?: string}}>};
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('AI provider returned an empty response');
    return content;
  }
}

export class GeminiProvider implements AIProvider {
  constructor(private readonly apiKey: string, private readonly model: string) {}
  async run(kind: AITaskKind, input: string): Promise<string> {
    const instruction: Record<AITaskKind, string> = {
      review: 'Revisa este diff como senior engineer. Devuelve solo hallazgos concretos y priorizados en español.',
      'commit-msg': 'Propón un mensaje de commit imperativo de máximo 72 caracteres.',
      resolve: 'Analiza los conflictos y propone una resolución explicando los riesgos.',
      ask: 'Eres el asistente de AIVerse. Responde en español, explica con claridad, usa el contexto de código proporcionado, sugiere siguientes pasos concretos y nunca afirmes que modificaste archivos.',
    };
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({systemInstruction: {parts: [{text: instruction[kind]}]}, contents: [{role: 'user', parts: [{text: input}]}]}),
    });
    if (!response.ok) throw new Error(`Gemini responded with ${response.status}`);
    const data = await response.json() as {candidates?: Array<{content?: {parts?: Array<{text?: string}>}}>} ;
    const text = data.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('').trim();
    if (!text) throw new Error('Gemini returned an empty response');
    return text;
  }
}

export class AITaskQueue {
  private readonly pending = new Queue<AITask>();
  private readonly tasks = new Map<string, AITask>();
  private running = 0;
  private sequence = 0;
  constructor(private readonly provider: AIProvider, private readonly concurrency = 2, private readonly maxRetries = 2, private readonly onChange: (task: AITask) => void = () => undefined) {}
  enqueue(kind: AITaskKind, input: string): AITask {
    const now = new Date().toISOString();
    const task: AITask = {id: String(++this.sequence), kind, input, state: 'pending', attempts: 0, createdAt: now, updatedAt: now};
    this.tasks.set(task.id, task); this.pending.enqueue(task); this.onChange(task); this.schedule(); return task;
  }
  get(id: string): AITask | undefined { return this.tasks.get(id); }
  list(): AITask[] { return [...this.tasks.values()].sort((a, b) => Number(b.id) - Number(a.id)); }
  private schedule(): void { while (this.running < this.concurrency && this.pending.size > 0) { const task = this.pending.dequeue(); if (!task) return; this.running++; void this.execute(task); } }
  private async execute(task: AITask): Promise<void> {
    task.state = 'processing'; task.attempts++; task.updatedAt = new Date().toISOString(); this.onChange(task);
    try { task.result = await this.provider.run(task.kind, task.input); task.state = 'ready'; task.error = undefined; }
    catch (error) { task.error = error instanceof Error ? error.message : String(error); if (task.attempts <= this.maxRetries) { task.state = 'pending'; this.pending.enqueue(task); } else task.state = 'error'; }
    finally { task.updatedAt = new Date().toISOString(); this.running--; this.onChange(task); this.schedule(); }
  }
}

