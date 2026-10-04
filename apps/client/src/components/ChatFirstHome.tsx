import React from 'react';
import { Navigate, useParams } from 'react-router-dom';

export default function ChatFirstHome() {
  const { wsId } = useParams<{ wsId: string }>();
  return <Navigate to={`/ws/${wsId}/sessions`} replace />;
}
