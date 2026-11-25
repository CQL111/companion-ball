// errors.ts - 错误码 → 给用户看的一句话
import type { TextCheck } from './types'
import { textErrorText } from './validate'

export function bottleErrorText(code: string): string {
  switch (code) {
    case 'DAILY_LIMIT':
      return '今天放得够多了，明天再来'
    case 'SERVICE_PAUSED':
      return '猫邮局暂时关门了'
    case 'REVOKED':
      return '这个设备暂时不能寄信了'
    case 'NOT_FOUND':
    case 'ALREADY_REPLIED':
      return '这张纸条已经漂走了'
    case 'SELF_REPLY':
      return '这是你自己写的'
    case 'NO_BOTTLE':
      return '纸条不见了'
    case 'NETWORK':
      return '海面不太平静，等会儿再试'
    case 'EMPTY':
    case 'TOO_LONG':
    case 'CONTACT':
    case 'LINK':
      return textErrorText(code as TextCheck['reason'])
    default:
      return '出了点问题，等会儿再试'
  }
}
