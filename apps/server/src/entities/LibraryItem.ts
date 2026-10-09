import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

// 자료실 — 파일 바이트는 Resource(`type='library_file'`, base64)에 그대로 두고,
// 배포·공유에 필요한 겉장만 이 테이블에 둔다. 바이트 저장을 새로 만들지 않는 이유:
// ResourceMediaController의 raw 업로드(10MB JSON 상한 우회)·/raw 스트리밍(Range)·
// 워크스페이스 격리가 그대로 재사용된다. 다운로드는 `/api/resources/:id/raw?download=1`.
// kind='app'은 설치물(APK 등) — 버전이 붙고 `apps/latest` 로 최신본 하나를 뽑는다.
@Entity('library_items')
@Index('idx_library_items_workspace', ['account_id'])
@Index('idx_library_items_kind', ['account_id', 'kind'])
export class LibraryItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  account_id: string | null;

  // resources.id — 같은 account_id 여야 한다(크로스 워크스페이스 참조 금지).
  @Column({ type: 'varchar' })
  resource_id: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  // 자유 문자열(예: "1.0", "1.0 (1)") — latest는 버전 비교가 아니라 생성 순서다.
  @Column({ type: 'varchar', default: '' })
  version: string;

  // 'app' | 'file' — 그 밖은 'file'로 접는다.
  @Column({ type: 'varchar', default: 'file' })
  kind: string;

  @Column({ type: 'varchar', default: '' })
  created_by: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
