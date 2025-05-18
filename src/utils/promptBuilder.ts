// 分岐・主語明示型プロンプト生成ユーティリティ
// bocchy_core_rules準拠
import type { BranchNode } from './branchTree.js';

export function buildPrompt(branch: BranchNode): string {
  let prompt = `[仮説: ${branch.hypothesis || 'メイン'}] 主語: ${branch.subject}\n`;
  branch.messages.forEach((msg: any) => {
    prompt += msg + "\n";
  });
  return prompt;
} 