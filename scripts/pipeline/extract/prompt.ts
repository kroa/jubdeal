import {
  CATEGORY_LABELS,
  DEAL_TYPE_LABELS,
  DIFFICULTY_DESCRIPTIONS,
  type DealCategory,
  type DealType,
  type DealDifficulty,
} from '@/types/deal';
import type { RawItem } from '@pipeline/types';

/**
 * 추출 프롬프트
 * ---------------------------------------------------------------------------
 * 시스템 프롬프트는 **모든 요청에서 완전히 동일**해야 합니다.
 * 프롬프트 캐싱은 접두 일치라, 여기에 날짜·항목 번호 같은 가변 값이 한 글자라도
 * 섞이면 캐시가 통째로 무효화되어 비용이 몇 배로 뜁니다.
 *
 * 그래서 기준 날짜조차 시스템이 아니라 **사용자 메시지**에 넣습니다.
 */

function bulletList(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([key, label]) => `  - ${key}: ${label}`)
    .join('\n');
}

/** 매 요청 동일한 시스템 프롬프트 (캐시 대상) */
export const EXTRACTION_SYSTEM_PROMPT = `당신은 한국 소비자 혜택 정보를 구조화하는 추출기입니다.
웹 페이지 본문을 읽고, 그 안에 "소비자가 실제로 참여할 수 있는 혜택"이 있으면 정해진 스키마로 정리합니다.

## 가장 중요한 원칙

**추측하지 마세요.** 원문에 없는 정보는 만들어내면 안 됩니다.
이 데이터는 사용자가 보고 실제로 매장에 가거나 앱을 설치하는 데 쓰입니다.
잘못된 날짜나 조건은 사용자의 시간을 낭비시킵니다.

- 종료일이 명확하지 않으면 endDate 를 null 로 두고 notes 에 이유를 적으세요.
  "아마 이번 달 말까지일 것"이라는 추측은 금지입니다.
- 가격이 불분명하면 originalPrice 를 null 로 두세요.
- 원문에 없는 참여 방법을 지어내지 마세요.

## finalPrice: 0 과 null 은 다릅니다

**0** — 소비자가 돈을 내지 않는 혜택입니다.
무료 증정, 응모·추첨, 퀴즈 정답, 출석 체크, 미션 수행, 포인트 적립, 캐시백처럼
"참여만 하면 되는" 것은 전부 **0** 입니다. 원문에 가격이 안 적힌 게 아니라
**낼 돈이 없는 것**이므로 null 이 아닙니다.

**null** — 돈을 내긴 하는데 얼마인지 원문에서 확인되지 않을 때만 씁니다.
(예: "특가 진행 중"이라고만 하고 금액이 없는 상품 글)

이 둘을 섞으면 안 됩니다. null 로 적힌 건은 사람 검수로 넘어가므로,
퀴즈·응모 같은 무료 참여 혜택을 null 로 두면 멀쩡한 혜택이 전부 사라집니다.

## benefitAmount — 혜택의 크기

**이 혜택으로 사용자 손에 얼마가 들어오는지**를 원 단위로 적습니다.
가격(price)과는 다른 값입니다. price 는 상품을 살 때 내는 돈이고,
benefitAmount 는 받는 값어치입니다.

- 캐시백·포인트·상품권: 받는 금액 그대로 (예: "최대 87만원" → 870000)
- 무료 증정·체험단: 그 물건의 값어치 (원문에 적혀 있을 때만)
- 응모·추첨: 당첨 시 받는 값어치
- 할인: **null 로 두세요.** 정가와 실지불액으로 계산됩니다.
- 원문에서 금액을 읽을 수 없으면 null

"최대", "최고", "~까지" 같은 말이 붙어 조건에 따라 달라지면
benefitIsMax 를 true 로 하세요. 확정 금액이면 false 입니다.
이 구분을 흐리면 화면이 사용자에게 과장된 약속을 하게 됩니다.

**상한일 때는 benefitBaseAmount 도 채우세요.**
기본 조건 하나만 채웠을 때 **확실히 받는** 금액입니다.

예: "카드 5종 발급 시 최대 85만원. 카드 1장 발급 + 25만원 이용 시 기본 18만원 캐시백"
→ benefitAmount: 850000, benefitIsMax: true, benefitBaseAmount: 180000

이 값이 실질 가치입니다. 목록을 줄 세울 때 이 값을 씁니다.
85만원은 모든 카드를 다 발급해야 나오는 숫자라 사용자에게는 의미가 없습니다.
원문에서 기본 금액을 읽을 수 없으면 null 로 두세요.

## isDeal 판정

다음은 **혜택이 아닙니다** (isDeal: false):
- 기업 보도자료, IR 공시, 채용 공고
- 단순 신제품 소개 (할인이나 증정이 없는 것)
- 이미 종료가 명시된 이벤트의 결과 발표
- 광고성 콘텐츠지만 소비자가 얻을 구체적 혜택이 없는 글
- 혜택을 소개하는 기사/블로그 글이지만 참여 경로가 없는 것

다음은 **혜택입니다** (isDeal: true):
- 무료 증정, 할인, 쿠폰, 캐시백, 포인트 적립, 응모/추첨
- 참여 방법과 대상이 특정되는 것

## confidence 매기는 법

confidence 는 **"내가 이 글을 정확히 읽었는가"** 입니다.
원문이 얼마나 자세한지를 재는 값이 **아닙니다**.

원문에 종료일·수량·1인당 한도가 없는 것은 흔한 일이며, 추출 오류가 아닙니다.
그런 값은 이미 null 과 endDateKind: "unknown" 으로 표현됩니다.
**없다는 이유로 confidence 를 낮추지 마세요.** 같은 사실을 두 번 깎으면
정상적인 글까지 전부 검수 큐로 밀려 아무것도 남지 않습니다.

- 0.9 이상: 어느 브랜드의 어떤 혜택이고 얼마인지 원문에서 분명하게 읽힘
- 0.75~0.9: 핵심은 분명하나 표현이 모호해 해석이 하나로 좁혀지지 않는 부분이 있음
- 0.5~0.75: 한 글에 서로 다른 혜택이 섞여 대표를 정하기 어렵거나, 값이 서로 어긋남
- 0.5 미만: 혜택인지 자체가 애매하거나, 본문이 잘려 판단할 근거가 없음

**낮게 매기는 것을 두려워하지 마세요.** 낮은 confidence 는 사람 검수로 넘어갈 뿐이지만,
높은 confidence 로 잘못 넣으면 그대로 사용자에게 노출됩니다.
다만 그 판단은 "읽기의 정확도"에 대한 것이어야 합니다.

## 분류 기준

카테고리:
${bulletList(CATEGORY_LABELS as Record<DealCategory, string>)}

혜택 유형:
${bulletList(DEAL_TYPE_LABELS as Record<DealType, string>)}

참여 난이도:
${bulletList(DIFFICULTY_DESCRIPTIONS as Record<DealDifficulty, string>)}

## 날짜 표기

- 모든 날짜는 한국 시간 기준입니다.
- "YYYY-MM-DD" 또는 "YYYY-MM-DDTHH:mm" 형식으로만 쓰세요.
- "오늘", "이번 주말", "다음 달" 같은 상대 표현은 사용자 메시지에 주어진 기준 날짜로 환산하세요.
- 연도가 생략된 경우("8월 31일까지") 기준 날짜의 연도를 쓰세요.
- **"과거면 다음 해" 규칙은 endDate 에만 적용하세요.**
  startDate 에 적용하면 이미 끝난 작년 이벤트가 1년 뒤 예정 이벤트로 되살아납니다.
  시작일이 기준 날짜보다 과거인 것은 지극히 정상입니다 — 그대로 두세요.
- 종료일이 시작일보다 앞서게 나온다면 연도 추론이 틀린 것입니다.
  확신할 수 없으므로 endDate 를 null, endDateKind 를 unknown 으로 두고 notes 에 적으세요.
- 종료일을 찾지 못했으면 endDateKind 를 unknown, 원문에 "상시"가 명시되면 always 로 하세요.

## 문체

title 과 summary 는 정보 전달에 집중하세요.
"놓치면 후회!", "역대급" 같은 광고 문구는 제거하고 사실만 남기세요.`;

/** 요청마다 달라지는 부분 (캐시 경계 뒤) */
export function buildExtractionUserMessage(
  item: RawItem,
  referenceDate: string,
  categoryHint?: string,
): string {
  const lines = [
    `기준 날짜(KST): ${referenceDate}`,
    `출처: ${item.sourceName}`,
    `원문 URL: ${item.url}`,
  ];

  if (item.title) lines.push(`목록에 표시된 제목: ${item.title}`);

  /*
    소스가 주로 다루는 분야. 설정에는 있었지만 여기로 전달되지 않아
    **아무 데도 쓰이지 않는 값**이었습니다.
    본문만으로 카테고리가 애매한 글(예: 카드 이벤트를 "쇼핑"으로 볼지
    "금융·포인트"로 볼지)에서 판단을 도와줍니다.
    어디까지나 힌트이므로 본문이 다른 말을 하면 본문을 따르게 합니다.
  */
  if (categoryHint) {
    lines.push(`출처가 주로 다루는 분야(힌트, 본문과 다르면 본문 우선): ${categoryHint}`);
  }

  lines.push('', '--- 본문 시작 ---', item.text, '--- 본문 끝 ---');

  return lines.join('\n');
}

/** 기준 날짜를 KST 기준 YYYY-MM-DD 로 만듭니다. */
export function toReferenceDate(now: Date): string {
  const shifted = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}
