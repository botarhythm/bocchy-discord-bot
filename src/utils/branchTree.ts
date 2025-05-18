// 分岐ツリー型会話履歴管理ユーティリティ
// bocchy_core_rules準拠

export interface BranchNode {
  id: string;
  parentId: string | null;
  subject: string;
  hypothesis?: string;
  messages: string[];
  children: BranchNode[];
}

export function createBranchNode(params: Partial<BranchNode> & { id: string }): BranchNode {
  return {
    id: params.id,
    parentId: params.parentId ?? null,
    subject: params.subject ?? '',
    hypothesis: params.hypothesis,
    messages: params.messages ?? [],
    children: params.children ?? [],
  };
} 