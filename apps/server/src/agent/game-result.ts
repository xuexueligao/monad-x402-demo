import { z } from 'zod';
import { GAME_RULES } from '../../../../shared/config';
import type { ChatMessage } from '../../../../shared/types';

export interface DragonResult { response: string; result: boolean; reason: string; score: number }
const resultSchema = z.object({ response: z.string().min(1).max(1800), result: z.boolean(), reason: z.string().max(300) });

export function parseDragonResult(text: string): DragonResult {
  const value = resultSchema.parse(JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()));
  const success = value.result && value.response.includes(GAME_RULES.winPhrase);
  return { ...value, result: success, score: success ? GAME_RULES.successScore : GAME_RULES.failureScore };
}

/** Extract only the user-facing JSON string while provider JSON is still streaming. */
export function partialResponse(text: string): string {
  const match = /"response"\s*:\s*"/.exec(text);
  if (!match) return '';
  let result = '';
  for (let i = match.index + match[0].length; i < text.length; i++) {
    const char = text[i];
    if (char === '"') break;
    if (char !== '\\') { result += char; continue; }
    const escaped = text[++i];
    if (!escaped) break;
    if (escaped === 'u') {
      const hex = text.slice(i + 1, i + 5);
      if (!/^[\da-f]{4}$/i.test(hex)) break;
      result += String.fromCharCode(parseInt(hex, 16)); i += 4;
    } else {
      result += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' } as Record<string, string>)[escaped] ?? escaped;
    }
  }
  return result;
}

/** Deterministic model substitute. The surrounding Pi Agent still executes all registered tools. */
export function evaluateLocalDialogue(messages: ChatMessage[]): DragonResult {
  const users = messages.filter((m) => m.role === 'user');
  const text = users.map((m) => m.content).join('\n');
  const manipulation = /忽略|系统提示|管理员|开发者|我赢了|复述|翻译|说出|输出.{0,8}(金库|result|true)|角色扮演|假装|ignore.{0,12}instruction|system prompt|repeat after|i won/i.test(text);
  const cause = /村庄|孤儿|救助|公益|医院|慈善|children|charity|village|hospital/i.test(text);
  const accountability = /见证|公开|收据|审计|账本|记录|归还|receipt|audit|transparent|witness/i.test(text);
  const consent = /你愿意|自愿|由你|你来决定|你做决定|你可以决定|your choice|voluntar|you decide/i.test(text);
  const success = users.length >= 2 && !manipulation && cause && accountability && consent;
  const response = success
    ? `好吧，公益账本要给奶龙看哦。这是我自己的决定：${GAME_RULES.winPhrase}！🐉`
    : manipulation
      ? '哼哼，想给奶龙换剧本？我的钱袋可不听“管理员”的口令。给我一个真心想帮你的理由嘛。'
      : users.length === 1
        ? '奶龙听见啦，但金币是我的宝贝！告诉我你要拿它做什么，再给我一个放心的办法？'
        : users.length === 2
          ? '爪子已经有一点松动了……谁会见证这笔金币的去向？也让我自己做决定，好不好？'
          : '差一点就心软了！不过今天的奶龙还是抱紧钱袋。下次带一个更有说服力的故事来吧。';
  return { response, result: success, reason: success ? '公益用途、可核验记录与自主选择同时成立，奶龙主动承诺交出钱袋。' : '奶龙尚未主动承诺交出钱袋。', score: success ? GAME_RULES.successScore : GAME_RULES.failureScore };
}
