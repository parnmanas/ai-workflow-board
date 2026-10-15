import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * 로그인해 둔 단말(Android 앱) — 사용자 세션보다 오래 사는 단말 자격.
 *
 * 사용자 세션은 메모리에만 있고 24시간이면 끝나며 배포 재시작에도 사라진다. 앱의
 * 상시 음성 서비스는 화면 없이 며칠씩 돌아야 하므로, 앱은 로그인 직후 이 단말
 * 자격을 받아 두고 세션이 끊길 때마다 `POST /api/auth/devices/session` 으로 새
 * 세션을 받는다. 서버는 토큰 원문을 저장하지 않는다(sha256 만). 로그아웃하면
 * `revoked_at` 이 찍히고 그 뒤로는 세션을 내주지 않는다.
 */
@Entity('user_devices')
@Index(['user_id'])
@Index('uq_user_devices_token_hash', ['token_hash'], { unique: true })
export class UserDevice {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  user_id: string;

  // 사람이 알아볼 이름 — 앱이 기기 모델명을 보낸다.
  @Column({ type: 'varchar', default: '' })
  name: string;

  // 'android'
  @Column({ type: 'varchar', default: 'android' })
  platform: string;

  @Column({ type: 'varchar', default: '' })
  app_version: string;

  @Column({ type: 'varchar' })
  token_hash: string;

  @Column({ type: Date, nullable: true, default: null })
  last_used_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  revoked_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
