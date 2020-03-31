import { LOADED } from './constants.js';

// Checks whether this tile was last used on the given frame.
function isUsedThisFrame( tile, frameCount ) {

	return tile.__lastFrameVisited === frameCount && tile.__used;

}

// Resets the frame frame information for the given tile
function resetFrameState( tile, frameCount ) {

	if ( tile.__lastFrameVisited !== frameCount ) {

		tile.__lastFrameVisited = frameCount;
		tile.__used = false;
		tile.__inFrustum = false;
		tile.__isLeaf = false;
		tile.__visible = false;
		tile.__active = false;
		tile.__error = 0;
		tile.__childrenWereVisible = false;

	}

}

// Recursively mark tiles used down to the next tile with content
function recursivelyMarkUsed( tile, frameCount, lruCache ) {

	resetFrameState( tile, frameCount );

	tile.__used = true;
	lruCache.markUsed( tile );
	if ( tile.__contentEmpty ) {

		const children = tile.children;
		for ( let i = 0, l = children.length; i < l; i ++ ) {

			recursivelyMarkUsed( children[ i ], frameCount, lruCache );

		}

	}

}

// Helper function for recursively traversing a tileset. If `beforeCb` returns `true` then the
// traversal will end early.
export function traverseSet( tile, beforeCb = null, afterCb = null, parent = null, depth = 0 ) {

	if ( beforeCb && beforeCb( tile, parent, depth ) ) {

		if ( afterCb ) {

			afterCb( tile, parent, depth );

		}

		return;

	}

	const children = tile.children;
	for ( let i = 0, l = children.length; i < l; i ++ ) {

		traverseSet( children[ i ], beforeCb, afterCb, tile, depth + 1 );

	}

	if ( afterCb ) {

		afterCb( tile, parent, depth );

	}

}

// Determine which tiles are within the camera frustum.
// TODO: include frustum mask here?
// TODO: this is marking items as used in the lrucache, which means some data is
// being kept around that isn't being used -- is that okay?
export function determineFrustumSet( tile, renderer ) {

	const stats = renderer.stats;
	const frameCount = renderer.frameCount;
	const errorTarget = renderer.errorTarget;
	const maxDepth = renderer.maxDepth;
	const loadSiblings = renderer.loadSiblings;
	const lruCache = renderer.lruCache;
	resetFrameState( tile, frameCount );

	// Early out if this tile is not within view.
	const inFrustum = renderer.tileInView( tile );
	if ( inFrustum === false ) {

		return false;

	}

	tile.__used = true;
	lruCache.markUsed( tile );

	tile.__inFrustum = true;
	stats.inFrustum ++;

	// Early out if this tile has less error than we're targeting.
	if ( ! tile.__contentEmpty ) {

		const error = renderer.calculateError( tile );
		tile.__error = error;
		if ( error <= errorTarget ) {

			return true;

		}

	}

	// Early out if we've reached the maximum allowed depth.
	if ( renderer.maxDepth > 0 && tile.__depth + 1 >= maxDepth ) {

		return true;

	}

	// Traverse children and see if any children are in view.
	let anyChildrenUsed = false;
	const children = tile.children;
	for ( let i = 0, l = children.length; i < l; i ++ ) {

		const c = children[ i ];
		const r = determineFrustumSet( c, renderer );
		anyChildrenUsed = anyChildrenUsed || r;

	}

	// If there are children within view and we are loading siblings then mark
	// all sibling tiles as used, as well.
	if ( anyChildrenUsed && loadSiblings ) {

		for ( let i = 0, l = children.length; i < l; i ++ ) {

			recursivelyMarkUsed( tile, frameCount, lruCache );

		}

	}

	return true;

}

// Traverse and mark the tiles that are at the leaf nodes of the "used" tree.
export function markUsedSetLeaves( tile, renderer ) {

	const stats = renderer.stats;
	const frameCount = renderer.frameCount;
	if ( ! isUsedThisFrame( tile, frameCount ) ) {

		return;

	}

	stats.used ++;

	// This tile is a leaf if none of the children had been used.
	const children = tile.children;
	let anyChildrenUsed = false;
	for ( let i = 0, l = children.length; i < l; i ++ ) {

		const c = children[ i ];
		anyChildrenUsed = anyChildrenUsed || isUsedThisFrame( c, frameCount );

	}


	if ( ! anyChildrenUsed ) {

		// TODO: This isn't necessarily right because it's possible that a parent tile is considered in the
		// frustum while the child tiles are not, making them unused. If all children have loaded and were properly
		// considered to be in the used set then we shouldn't set ourselves to a leaf here.
		tile.__isLeaf = true;

		// TODO: stats

	} else {

		let childrenWereVisible = false;
		for ( let i = 0, l = children.length; i < l; i ++ ) {

			const c = children[ i ];
			markUsedSetLeaves( c, renderer );
			childrenWereVisible = childrenWereVisible || c.__wasSetVisible || c.__childrenWereVisible;

		}
		tile.__childrenWereVisible = childrenWereVisible;

	}

}

// Skip past tiles we consider unrenderable because they are outside the error threshold.
export function skipTraversal( tile, renderer ) {

	const stats = renderer.stats;
	const frameCount = renderer.frameCount;
	if ( ! isUsedThisFrame( tile, frameCount ) ) {

		return;

	}

	// Request the tile contents or mark it as visible if we've found a leaf.
	const lruCache = renderer.lruCache;
	if ( tile.__isLeaf ) {

		if ( tile.__loadingState === LOADED ) {

			if ( tile.__inFrustum ) {

				tile.__visible = true;
				stats.visible ++;

			}
			tile.__active = true;
			stats.active ++;

		} else if ( ! lruCache.isFull() ) {

			renderer.requestTileContents( tile );

		}
		return;

	}

	const errorRequirement = renderer.errorTarget * renderer.errorThreshold;
	const meetsSSE = tile.__error <= errorRequirement;
	const hasContent = ! tile.__contentEmpty;
	const loadedContent = tile.__loadingState === LOADED && ! tile.__contentEmpty;
	const childrenWereVisible = tile.__childrenWereVisible;
	const children = tile.children;
	let allChildrenHaveContent = true;
	for ( let i = 0, l = children.length; i < l; i ++ ) {

		const c = children[ i ];
		if ( isUsedThisFrame( c, frameCount ) ) {

			// TODO: This doesn't seem right -- we should check down to the next children with content?
			const childContent = c.__loadingState === LOADED || tile.__contentEmpty;
			allChildrenHaveContent = allChildrenHaveContent && childContent;

		}

	}

	// If we've met the SSE requirements and we can load content then fire a fetch.
	if ( meetsSSE && ! loadedContent && ! lruCache.isFull() && hasContent ) {

		renderer.requestTileContents( tile );

	}

	// Only mark this tile as visible if it meets the screen space error requirements, has loaded content, not
	// all children have loaded yet, and if no children were visible last frame. We want to keep children visible
	// that _were_ visible to avoid a pop in level of detail as the camera moves around and parent / sibling tiles
	// load in.
	if ( meetsSSE && ! allChildrenHaveContent && ! childrenWereVisible ) {

		if ( loadedContent ) {

			if ( tile.__inFrustum ) {

				tile.__visible = true;
				stats.visible ++;

			}
			tile.__active = true;
			stats.active ++;

			for ( let i = 0, l = children.length; i < l; i ++ ) {

				const c = children[ i ];
				if ( isUsedThisFrame( c, frameCount ) && ! lruCache.isFull() ) {

					renderer.requestTileContents( c );

				}

			}

		}
		return;

	}

	for ( let i = 0, l = children.length; i < l; i ++ ) {

		const c = children[ i ];
		if ( isUsedThisFrame( c, frameCount ) ) {

			skipTraversal( c, renderer );

		}

	}

}

export function toggleTiles( tile, renderer ) {

	const frameCount = renderer.frameCount;
	const isUsed = isUsedThisFrame( tile, frameCount );
	if ( isUsed || tile.__usedLastFrame ) {

		let setActive = false;
		let setVisible = false;
		if ( isUsed ) {

			// enable visibility if active due to shadows
			setActive = tile.__active;
			setVisible = tile.__active || tile.__visible;

		}

		if ( ! tile.__contentEmpty && tile.__loadingState === LOADED ) {

			if ( tile.__wasSetActive !== setActive ) {

				renderer.setTileVisible( tile, setActive );

			}

			if ( tile.__wasSetVisible !== setVisible ) {

				renderer.setTileActive( tile, setVisible );

			}

		}
		tile.__wasSetActive = setActive;
		tile.__wasSetVisible = setVisible;
		tile.__usedLastFrame = isUsed;

		const children = tile.children;
		for ( let i = 0, l = children.length; i < l; i ++ ) {

			const c = children[ i ];
			toggleTiles( c, renderer );

		}

	}

}
