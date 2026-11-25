// alias.ts - 匿名代号：每次随机、不复用
// 同一张纸条的投递者与回信者之间没有任何可关联的标识。

export const ALIAS_ADJECTIVES = [
  '夜里的', '路过的', '安静的', '早起的', '走神的', '发呆的',
  '慢吞吞的', '突然的', '刚睡醒的', '加班的', '淋了雨的', '不想说话的',
]

export const ALIAS_NOUNS = [
  '橘子', '路灯', '猫', '水杯', '窗台', '雨伞', '台灯', '影子', '枕头', '台阶',
  '咖啡渍', '玻璃', '钥匙', '空气', '月亮', '地铁', '纸团', '耳机', '拖鞋', '天气预报',
]

export function randomAlias(random: () => number = Math.random): string {
  // 两个维度用**不同的**随机值：正态的 random() 实现里，两次连续调用可能高度相关，
  // 那样代号会退化成只覆盖少量组合。
  const pickA = random()
  const pickN = random()
  const a = ALIAS_ADJECTIVES[Math.floor(pickA * ALIAS_ADJECTIVES.length)] ?? '路过的'
  const n = ALIAS_NOUNS[Math.floor(pickN * ALIAS_NOUNS.length)] ?? '猫'
  return a + n
}
