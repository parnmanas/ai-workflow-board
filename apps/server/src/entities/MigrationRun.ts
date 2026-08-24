import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * 도착지 주도(pull) live import 1회 실행 (ticket 0f638509).
 *
 * 소스 AWB 서버에서 이 서버(도착지)로 테이블을 순서대로 당겨오는 장기 실행
 * job의 durable 상태. DispatchIntent(내구성 outbox)와 같은 자세 — 진행 상황을
 * 매 배치마다 이 행에 커밋해서, 서버가 재시작돼도 `current_entity`/`cursor`부터
 * 재개할 수 있다(재-스캔이 아니라 재개). `entity_order`는 실행 시작 시점의
 * MIGRATION_ENTITY_ORDER 스냅샷 — 도중 코드가 배포돼 순서가 바뀌어도 같은 실행은
 * 자신이 시작한 순서를 끝까지 따른다.
 */
@Entity('migration_runs')
export class MigrationRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  source_url: string;

  // AES-256-GCM 암호화된 소스 단기 TTL 토큰. 평문은 절대 저장하지 않는다 —
  // 소스 자신도 만료/폐기하지만, 이 행에 남는 사본도 같은 원칙을 따른다.
  @Column({ type: 'text' })
  source_token_encrypted: string;

  // pending(생성 직후) → preflight(버전/스키마/빈 도착지 검사 중) → running(테이블
  // 복사 중) → completed | failed. 'paused'는 향후 수동 일시정지용으로 예약.
  @Column({ type: 'varchar', default: 'pending' })
  status: 'pending' | 'preflight' | 'running' | 'paused' | 'completed' | 'failed';

  // core = 본문 테이블(첨부/임베딩 제외) pull 중 또는 완료, attachments = 스킵
  //했던 첨부/임베딩을 채우는 후속 단계 pull 중, done = 더 이상 남은 작업이
  // 없는 진짜 최종 상태. status='completed' && phase='core' && skip_attachments=1
  // 조합이 "본문은 끝났고 첨부가 남았다" — pull-attachments 호출 전제조건이자
  // admin UI가 "Pull attachments" 버튼을 보여줄 조건이다.
  @Column({ type: 'varchar', default: 'core' })
  phase: 'core' | 'attachments' | 'done';

  // true면 core phase에서 TicketAttachment/ResourceEmbedding을 건너뛴다 — 본문을
  // 먼저 받고 용량이 큰 첨부/임베딩은 pull-attachments 엔드포인트로 별도 실행.
  @Column({ type: 'int', default: 0 })
  skip_attachments: number;

  // 비어있지 않은 도착지로의 import를 명시적으로 허용하는 오퍼레이터 플래그.
  // 충돌 정책은 단일 고정값: ON CONFLICT DO NOTHING(기존 행 보존, 신규만 채움).
  @Column({ type: 'int', default: 0 })
  allow_merge: number;

  // 현재(또는 마지막) 처리 중인 엔티티명 — MIGRATION_ENTITY_ORDER의 키.
  @Column({ type: 'varchar', nullable: true, default: null })
  current_entity: string | null;

  // 현재 엔티티에서 마지막으로 성공 처리한 PK 값(문자열화) — 재개 커서.
  @Column({ type: 'varchar', nullable: true, default: null })
  cursor: string | null;

  // 이 실행이 시작될 때 스냅샷한 테이블 순서(엔티티명 배열).
  @Column({ type: 'simple-json', nullable: true, default: null })
  entity_order: string[] | null;

  // 엔티티명 -> { pulled, done } 누적 진행 카운터. UI 진행률 표시 + 재개 판단용.
  @Column({ type: 'simple-json', default: '{}' })
  progress: Record<string, { pulled: number; done: boolean }>;

  // 프리플라이트 결과 스냅샷(버전/스키마 핑거프린트/행수 비교) — 감사/디버깅용.
  @Column({ type: 'simple-json', nullable: true, default: null })
  preflight_report: Record<string, unknown> | null;

  @Column({ type: 'text', default: '' })
  error_message: string;

  @Column({ type: 'varchar', default: '' })
  created_by: string;

  @Column({ type: Date, nullable: true, default: null })
  started_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  completed_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
