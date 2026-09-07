import { z } from 'zod';
import { DEAL_CATEGORIES, DEAL_DIFFICULTIES, DEAL_TYPES } from '@/types/deal';

/**
 * LLM 추출 스키마
 * ---------------------------------------------------------------------------
 * `src/lib/deal-schema.ts` 의 `dealSchema` 와 **일부러 다릅니다.**
 *
 * 모델이 알 수 없는 값은 여기에 두지 않습니다:
 *   - id / slug        → 파이프라인이 소스 URL 로부터 안정적으로 생성
 *   - source.*         → 수집기가 아는 값
 *   - meta.updatedAt   → 실행 시각
 *   - meta.verified    → 사람이 검수했는지 여부 (모델이 정할 수 없음)
 *
 * 모델에게 id 를 맡기면 매 실행마다 값이 달라져 같은 혜택이 중복 등록됩니다.
 *
 * 반대로 `isDeal` 과 `confidence` 는 **모델만 판단할 수 있어** 여기에 둡니다.
 */

/** 날짜는 "YYYY-MM-DD" 또는 "YYYY-MM-DDTHH:mm" 로 받고, 조립 단계에서 KST 오프셋을 붙입니다. */
const localDateTime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/,
    'YYYY-MM-DD 또는 YYYY-MM-DDTHH:mm 형식이어야 합니다.',
  );

export const extractedDealSchema = z.object({
  /**
   * 이 문서가 실제로 "소비자가 참여할 수 있는 혜택"인지.
   * 공지·보도자료·상품 소개글을 걸러내는 1차 관문입니다.
   */
  isDeal: z.boolean().describe('소비자가 참여 가능한 혜택 정보이면 true, 아니면 false'),

  /** 0~1. 추출 결과 전체에 대한 모델의 확신도 */
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('추출 정확도에 대한 확신도. 날짜나 조건이 불명확하면 낮게 매길 것'),

  /** 낮은 확신도의 이유 또는 사람이 확인해야 할 지점 */
  notes: z.string().describe('불확실한 부분이나 검수자가 확인해야 할 점. 없으면 빈 문자열'),

  title: z.string().max(120).describe('혜택 제목. 원문 제목을 다듬어 간결하게'),
  summary: z.string().max(200).describe('카드에 노출할 한 줄 요약'),
  /*
    없어도 됩니다.

    "없으면 빈 문자열"이라고 적어 뒀지만 모델은 그냥 필드를 **빼버립니다.**
    필수로 두면 그때마다 혜택이 통째로 거절됩니다. 실제로 한 실행에서
    5건이 이렇게 날아갔습니다. 상세 설명이 없는 혜택은 흔하고,
    조립 단계도 빈 값이면 필드를 안 넣으니 필수일 이유가 없습니다.
  */
  description: z.string().optional().describe('상세 설명. 없으면 생략'),

  /*
    없으면 조립 단계가 소스 이름으로 채웁니다.

    공공·문화 행사는 주최를 따로 밝히지 않는 글이 흔해 모델이 이 필드를
    통째로 빼버립니다. 필수로 두면 그때마다 행사가 거절됩니다.
    출처가 곧 주최인 경우가 대부분이라(경기문화재단, 국립중앙박물관)
    소스 이름이 무난한 대체값입니다.
  */
  brandName: z.string().optional().describe('혜택을 제공하는 브랜드/기업명. 모르면 생략'),

  category: z.enum(DEAL_CATEGORIES),
  dealType: z.enum(DEAL_TYPES),
  difficulty: z
    .enum(DEAL_DIFFICULTIES)
    .describe('easy=클릭 몇 번, normal=앱설치·가입 필요, hard=실적 등 조건 달성 필요'),

  /** 가격 — 알 수 없으면 null */
  originalPrice: z.number().int().nonnegative().nullable().describe('정가(원). 모르면 null'),
  finalPrice: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe(
      '실제 지불 금액(원). 참여에 돈이 들지 않으면 0 (무료·응모·퀴즈·출석·포인트·캐시백). ' +
        '돈은 내는데 액수를 알 수 없을 때만 null — 추측하지 말 것',
    ),

  firstComeFirstServed: z.boolean().describe('선착순 여부'),
  quantity: z.number().int().positive().nullable().describe('총 수량. 모르면 null'),
  perPersonLimit: z.number().int().positive().nullable().describe('1인당 참여 제한. 모르면 null'),

  /** 기간 — 시작일을 모르면 null (조립 단계에서 수집 시각으로 대체) */
  /**
   * 이 혜택으로 손에 들어오는 금액(원). 원문에서 읽히지 않으면 null.
   * 할인처럼 정가·실지불액으로 계산되는 것은 조립 단계가 채우므로 null 로 두어도 됩니다.
   */
  benefitAmount: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe('혜택으로 받는 금액(원). 캐시백·포인트·증정의 값어치. 모르면 null'),
  /** "최대 N원"처럼 조건에 따라 달라지는 상한이면 true */
  benefitIsMax: z.boolean().describe('"최대 90만원"처럼 상한이면 true, 확정 금액이면 false'),
  /** 기본 조건만 채웠을 때 확실히 받는 금액. 상한일 때만 의미가 있습니다. */
  benefitBaseAmount: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe('기본 조건만 채웠을 때 확실히 받는 금액(원). 원문에 없으면 null'),

  startDate: localDateTime.nullable().describe('시작일. 명시가 없으면 null'),
  endDate: localDateTime.nullable().describe('종료일. 모르거나 상시면 null'),

  /**
   * endDate 가 null 인 이유를 구분합니다.
   * 이 구분이 없으면 "상시 진행"과 "종료일을 못 찾음"이 같아져,
   * 이미 끝난 혜택이 목록에 영원히 남습니다.
   */
  endDateKind: z
    .enum(['dated', 'always', 'unknown'])
    .describe('dated=날짜 있음, always=상시 진행 명시됨, unknown=종료일을 찾지 못함'),

  /** 참여 링크 — 원문에 명시된 것이 없으면 null (조립 단계에서 원문 URL 사용) */
  linkUrl: z.string().nullable().describe('참여 페이지 절대 URL. 없으면 null'),
  linkLabel: z.string().nullable().describe('버튼 문구. 없으면 null'),

  howTo: z.array(z.string()).describe('참여 방법 단계. 없으면 빈 배열'),
  caution: z.array(z.string()).describe('주의사항. 없으면 빈 배열'),
  /*
    개수를 여기서 막지 않습니다. 조립 단계의 `dedupeTags` 가 8개로 자릅니다.

    `.max(8)` 이었는데, Gemini 로 보내는 스키마에서는 `maxItems` 가 제거됩니다
    (Gemini 가 이해하지 못하는 키워드라 toGeminiSchema 가 버립니다).
    그래서 모델은 제한을 모른 채 9개를 내고, 우리는 항목을 통째로 거절했습니다.
    실제로 아정당 카드 이벤트 한 건이 이렇게 버려졌습니다.

    자르는 쪽을 `.transform` 으로 옮겨 봤지만 Zod 4 는 transform 을
    JSON Schema 로 표현하지 못합니다("Transforms cannot be represented in
    JSON Schema") — 이 스키마는 프로바이더에게 보낼 JSON Schema 로도
    쓰이므로 transform 을 넣을 수 없습니다.

    태그를 하나 더 붙였다고 혜택 정보를 버릴 이유가 없습니다.
  */
  tags: z.array(z.string()).describe('검색용 태그. 8개 이하'),
});

export type ExtractedDeal = z.infer<typeof extractedDealSchema>;

/** 이 값 미만이면 자동 반영하지 않고 사람 검수 큐로 보냅니다. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;
