import yaml from 'js-yaml';
import fs from 'fs';

const config: any = yaml.load(fs.readFileSync('bot_logic.yaml', 'utf8'));

export function pickAction(flags: Record<string, boolean>): string | null {
  const active = Object.entries(flags).filter(([k, v]) => v).map(([k]) => k);
  for (const rule of config.decision_matrix) {
    if (rule.when.length === active.length && rule.when.every((f: string) => active.includes(f))) {
      return rule.action;
    }
  }
  return null;
} 