import React, { useEffect, useMemo, useRef, useState } from 'react';
import Graph from 'graphology';
import Sigma from 'sigma';
import type { OntologyGraphSnapshotNode, OntologyGraphSnapshotResponse } from '../../types';
import { tokens } from '../../tokens';

const NODE_COLORS: Record<string, string> = {
  File: tokens.colors.info,
  Callable: tokens.colors.success,
  Type: tokens.colors.warning,
  Field: tokens.colors.danger,
};

function clusterOf(node: OntologyGraphSnapshotNode): string {
  const path = node.path.replace(/^\/+/, '');
  return path.split('/')[0] || '(root)';
}

function buildGraph(snapshot: OntologyGraphSnapshotResponse): Graph {
  const graph = new Graph({ multi: true, type: 'directed' });
  const clusters = [...new Set(snapshot.nodes.map(clusterOf))].sort();
  const clusterIndex = new Map(clusters.map((cluster, index) => [cluster, index]));
  const members = new Map<string, number>();

  for (const node of snapshot.nodes) {
    const cluster = clusterOf(node);
    const member = members.get(cluster) || 0;
    members.set(cluster, member + 1);
    const clusterAngle = ((clusterIndex.get(cluster) || 0) / Math.max(1, clusters.length)) * Math.PI * 2;
    const ring = 2 + Math.sqrt(member + 1) * 0.34;
    const angle = clusterAngle + member * 2.399963;
    const centerRadius = Math.max(2, clusters.length * 0.7);
    graph.addNode(node.id, {
      ...node,
      cluster,
      label: node.name || node.qualified_name || node.id,
      x: Math.cos(clusterAngle) * centerRadius + Math.cos(angle) * ring,
      y: Math.sin(clusterAngle) * centerRadius + Math.sin(angle) * ring,
      size: Math.max(2, Math.min(12, 2 + Math.log2((node.degree || 0) + 1))),
      color: NODE_COLORS[node.type] || tokens.colors.textSecondary,
    });
  }
  for (const edge of snapshot.edges) {
    if (!graph.hasNode(edge.src_id) || !graph.hasNode(edge.dst_id)) continue;
    graph.addDirectedEdgeWithKey(edge.id, edge.src_id, edge.dst_id, {
      ...edge,
      size: Math.max(0.3, Math.min(2, edge.confidence * 1.5)),
      color: `${tokens.colors.textSecondary}55`,
    });
  }
  return graph;
}

export default function OntologyGraphCanvas({ snapshot }: { snapshot: OntologyGraphSnapshotResponse }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Sigma | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const graph = useMemo(() => buildGraph(snapshot), [snapshot]);
  const selected = selectedId ? snapshot.nodes.find((node) => node.id === selectedId) || null : null;

  selectedRef.current = selectedId;

  useEffect(() => {
    if (!containerRef.current) return;
    const renderer = new Sigma(graph, containerRef.current, {
      renderEdgeLabels: false,
      labelDensity: 0.08,
      labelGridCellSize: 120,
      hideEdgesOnMove: snapshot.edges.length > 2_000,
      zIndex: true,
    });
    rendererRef.current = renderer;
    const reduceNodes = (node: string, data: Record<string, any>) => {
      const isSelected = node === selectedRef.current;
      return {
        ...data,
        label: 1 / renderer.getCamera().getState().ratio > 1.7 || isSelected ? data.label : '',
        highlighted: isSelected,
        zIndex: isSelected ? 1 : 0,
      };
    };
    renderer.setSetting('nodeReducer', reduceNodes);
    renderer.refresh();
    renderer.on('clickNode', ({ node }) => setSelectedId(node));
    renderer.on('clickStage', () => setSelectedId(null));
    const camera = renderer.getCamera();
    const updateZoom = () => renderer.refresh();
    camera.on('updated', updateZoom);
    return () => {
      rendererRef.current = null;
      renderer.kill();
    };
  }, [graph, snapshot.edges.length]);

  useEffect(() => { rendererRef.current?.refresh(); }, [selectedId]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: selected ? 'minmax(0, 1fr) 280px' : '1fr', minHeight: 520, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, overflow: 'hidden', background: tokens.colors.surface }}>
      <div ref={containerRef} aria-label="Ontology graph canvas" style={{ minWidth: 0, minHeight: 520 }} />
      {selected && (
        <aside style={{ padding: 16, borderLeft: `1px solid ${tokens.colors.border}`, overflowWrap: 'anywhere' }}>
          <div style={{ fontWeight: tokens.typography.fontWeightSemibold }}>{selected.name}</div>
          <div style={{ color: tokens.colors.textSecondary, fontSize: tokens.typography.fontSizeXs, marginTop: 8 }}>{selected.type} · {selected.kind || selected.layer}</div>
          <div style={{ marginTop: 12, fontSize: tokens.typography.fontSizeSm }}>{selected.path}{selected.start_line ? `:${selected.start_line}` : ''}</div>
          <div style={{ marginTop: 12, color: tokens.colors.textSecondary, fontSize: tokens.typography.fontSizeXs }}>연결 {selected.degree}개 · {clusterOf(selected)} 클러스터</div>
        </aside>
      )}
    </div>
  );
}
