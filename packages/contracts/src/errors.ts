// errors.ts - 错误码 → 给用户看的一句话
import type { TextCheck } from './types'
import { textErrorText } from './validate'

export function bottleErrorText(code: string): string {
  switch (code) {
    case 'DAILY_LIMIT':
      return '今天放得够多了，明天再来'
    case 'RATE_LIMITED':
      return '慢一点，海面有点挤'
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
    // 后台 / 橱窗 / 新闻（P2 起）
    case 'GALLERY_OFF':
      return '窗口暂时关着'
    case 'NEWS_OFF':
      return '今天没有新消息'
    case 'NOT_APPROVED':
      return '这条还没被看见'
    case 'ADMIN_UNAUTHORIZED':
      return '请先登录'
    case 'FORBIDDEN':
      return '这个账号没有权限'
    case 'BAD_TOTP':
      return '验证码不对'
    case 'LOGIN_LOCKED':
      return '试了太多次，过一会儿再来'
    case 'NOT_PENDING':
      return '这条已经处理过了'
    case 'VALIDATION':
      return '内容不符合要求'
    default:
      return '出了点问题，等会儿再试'
  }
}
