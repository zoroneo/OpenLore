import { parseGraph, selectionBelongsToCluster } from './graph-helpers.js';

describe('parseGraph', () => {
  it('should parse structuralClusters and directoryClusters from raw data', () => {
    const raw = {
      nodes: [],
      edges: [],
      clusters: [],
      structuralClusters: [
        { id: 'cluster1', name: 'Structural Cluster 1', files: ['file1.js'], color: '#ff0000' },
      ],
      directoryClusters: [
        { id: 'dir1', name: 'Directory Cluster 1', files: ['dir/file.js'], color: '#00ff00' },
      ],
      statistics: {},
      rankings: {},
    };

    const result = parseGraph(raw);

    expect(result.structuralClusters).toEqual(raw.structuralClusters);
    expect(result.directoryClusters).toEqual(raw.directoryClusters);
  });

  it('should provide empty arrays for missing structuralClusters and directoryClusters', () => {
    const raw = {
      nodes: [],
      edges: [],
      clusters: [],
      statistics: {},
      rankings: {},
    };

    const result = parseGraph(raw);

    expect(result.structuralClusters).toEqual([]);
    expect(result.directoryClusters).toEqual([]);
  });
});

describe('selectionBelongsToCluster', () => {
  const graph = {
    nodes: [
      { id: 'a', cluster: { id: 'c1' } },
      { id: 'b', cluster: { id: 'c2' } },
      { id: 'c', cluster: null },
    ],
  };

  it('is true when the selected node lives in the collapsing cluster', () => {
    // guards the ghost-edge fix: selection must be cleared on this collapse
    expect(selectionBelongsToCluster(graph, 'a', 'c1')).toBe(true);
  });

  it('is false when the selected node is in a different cluster', () => {
    expect(selectionBelongsToCluster(graph, 'b', 'c1')).toBe(false);
  });

  it('is false when nothing is selected', () => {
    expect(selectionBelongsToCluster(graph, null, 'c1')).toBe(false);
  });

  it('is false when the selected id is not in the graph', () => {
    expect(selectionBelongsToCluster(graph, 'missing', 'c1')).toBe(false);
  });

  it('is false for a node with no cluster', () => {
    expect(selectionBelongsToCluster(graph, 'c', 'c1')).toBe(false);
  });

  it('handles a missing graph without throwing', () => {
    expect(selectionBelongsToCluster(null, 'a', 'c1')).toBe(false);
  });
});