export class ContextMemory {
  private buffer: { role: string, content: string }[] = [];
  private maxLength: number;

  constructor(maxLength: number) {
    this.maxLength = maxLength;
  }

  addMessage(role: string, content: string) {
    this.buffer.push({ role, content });
    if (this.buffer.length > this.maxLength) this.buffer.shift();
  }

  getRecentHistory(n?: number) {
    return this.buffer.slice(-(n ?? this.maxLength));
  }

  clear() {
    this.buffer = [];
  }
} 