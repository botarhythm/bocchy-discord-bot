// 主語階層管理・自動推定ユーティリティ
// bocchy_core_rules準拠

export class SubjectTracker {
  private subjectStack: string[] = [];

  push(subject: string) {
    this.subjectStack.push(subject);
  }

  pop() {
    this.subjectStack.pop();
  }

  current(): string | null {
    return this.subjectStack.length > 0 ? this.subjectStack[this.subjectStack.length - 1] : null;
  }

  // NLP候補と履歴から主語を自動推定（ユーザー確認なし）
  guessSubject(nlpCandidates: string[]): string | null {
    // NLP候補と履歴を照合し、最も直近の主語を優先
    for (let i = nlpCandidates.length - 1; i >= 0; i--) {
      if (this.subjectStack.includes(nlpCandidates[i])) {
        return nlpCandidates[i];
      }
    }
    // 候補がなければ直近の主語
    return this.current();
  }
  // デフォルト主語（ボッチー）
  static getDefaultSubject(): string {
    return 'ボッチー';
  }
} 