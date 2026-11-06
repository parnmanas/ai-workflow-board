import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import type { ChatRoomDetail, ChatRoomParticipantInfo } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { useToast } from '../../contexts/ToastContext';
import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import { tokens } from '../../tokens';
import { Button, Modal } from '../common';

/** Mounted for one room at a time; all names come from the room's resolved roster. */
export default function RoomParticipantsModal({ roomId, currentUserId, onClose, onChanged }: {
  roomId: string;
  currentUserId?: string;
  onClose: () => void;
  onChanged: (roomId: string) => void;
}) {
  useLocale();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const [detail, setDetail] = useState<ChatRoomDetail | null>(null);
  const [selected, setSelected] = useState<ChatRoomParticipantInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let current = true;
    setLoading(true);
    api.getChatRoom(roomId).then(room => {
      if (current) { setDetail(room); setError(''); }
    }).catch(err => {
      if (current) setError(err?.message || translate('Failed to load participants'));
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [roomId, revision]);

  useBoardStreamEvent('chat_room_update', event => {
    const payload = event?.payload ?? event;
    if (payload?.room_id === roomId && ['participant_added', 'participant_left'].includes(payload.update_type)) {
      setRevision(value => value + 1);
    }
  });

  const canRemove = !!detail?.can_remove_participants && hasPermission('chat.send');
  const close = () => {
    if (busy) return;
    if (selected) { setSelected(null); setError(''); }
    else onClose();
  };
  const remove = async () => {
    if (!selected || !detail || !canRemove || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.removeChatRoomParticipant(roomId, detail.account_id, selected.participant_type, selected.participant_id);
      setDetail(previous => previous && ({ ...previous, participants: previous.participants.filter(p =>
        p.participant_type !== selected.participant_type || p.participant_id !== selected.participant_id) }));
      setSelected(null);
      onChanged(roomId);
      showToast(translate('Participant removed'), 'success');
      setRevision(value => value + 1);
    } catch (err: any) {
      setError(err?.message || translate('Failed to remove participant'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={close} title={translate(selected ? 'Remove participant?' : 'Participants')} maxWidth={520}
      footer={selected ? <>
        <Button variant="secondary" onClick={close} disabled={busy}>{translate('Cancel')}</Button>
        <Button variant="danger" onClick={() => void remove()} loading={busy} disabled={!canRemove}>{translate('Remove participant')}</Button>
      </> : <Button variant="secondary" onClick={onClose}>{translate('Close')}</Button>}>
      {error && <div role="alert" style={{ color: tokens.colors.dangerLight, marginBottom: 12, overflowWrap: 'anywhere' }}>
        {error}
        {!selected && <Button variant="ghost" size="sm" onClick={() => setRevision(value => value + 1)}>{translate('Retry')}</Button>}
      </div>}
      {selected ? <div style={{ fontSize: 13, lineHeight: 1.6, overflowWrap: 'anywhere', color: tokens.colors.textPrimary }}>
        {translate('Remove {0} from this room? Existing messages will be kept.', { 0: selected.name })}
        {detail?.open_join && selected.participant_type === 'user' && <p style={{ color: tokens.colors.textSecondary }}>
          {translate('This room is open, so they can join again.')}
        </p>}
      </div> : <>
        {loading && !detail && <p>{translate('Loading…')}</p>}
        {detail && !canRemove && <p style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>
          {translate('Participants in this room cannot be removed here.')}
        </p>}
        <ul className="awb-room-participant-list">
          {detail?.participants.map(p => {
            const self = p.participant_type === 'user' && p.participant_id === currentUserId;
            return <li key={`${p.participant_type}:${p.participant_id}`}>
              <div style={{ minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>
                <strong style={{ color: tokens.colors.textPrimary }}>{p.name}</strong>
                <div style={{ color: tokens.colors.textSecondary, fontSize: 11 }}>{self ? translate('나') : translate(p.participant_type === 'agent' ? 'Agent' : 'User')}</div>
              </div>
              {canRemove && !self && <Button variant="danger" size="sm" aria-label={translate('Remove {0} from this room', { 0: p.name })}
                onClick={() => { setError(''); setSelected(p); }}>{translate('Remove participant')}</Button>}
            </li>;
          })}
        </ul>
      </>}
    </Modal>
  );
}
