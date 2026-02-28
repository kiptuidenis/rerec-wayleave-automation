import React, { useState, useEffect, useRef } from 'react';
import { Loader2, ZoomIn, ZoomOut, CheckCircle, ArrowLeft, MapPin, Map, AlertTriangle, Search, ChevronUp, ChevronDown, X } from 'lucide-react';
import { motion } from 'framer-motion';

const API_BASE = "http://localhost:8000";

const MapPinningView = ({ missingPins, sitePlanFile, onResolve, onBack }) => {
    const [pageUrls, setPageUrls] = useState([]);
    const [isLoadingImage, setIsLoadingImage] = useState(true);
    const [errorMsg, setErrorMsg] = useState(null);
    const [activeRecordId, setActiveRecordId] = useState(missingPins.length > 0 ? missingPins[0]._id : null);
    const [pins, setPins] = useState({}); // { _id: { _manual_x: float, _manual_y: float, _manual_page: int } }
    const [scale, setScale] = useState(1);

    // Multi-page Support
    const [totalPages, setTotalPages] = useState(0);
    const [loadingProgress, setLoadingProgress] = useState({ current: 0, total: 0 });

    // Native Search Support
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState([]);
    const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
    const [isSearching, setIsSearching] = useState(false);
    const [searchError, setSearchError] = useState(null);
    const pageRefs = useRef({});
    const scrollContainerRef = useRef(null);
    const scaleContainerRef = useRef(null);
    const currentScaleRef = useRef(1);

    // Sync ref when React changes it via other buttons (zoom + / zoom -)
    useEffect(() => {
        currentScaleRef.current = scale;
    }, [scale]);

    // Mouse Drag/Pan State
    const [isDragging, setIsDragging] = useState(false);
    const dragPosRef = useRef({ x: 0, y: 0, left: 0, top: 0 });

    const handleNativeWheelRef = useRef(null);

    // Provide a callback ref to attach the listener exactly when the element mounts
    const setScrollContainerRef = React.useCallback((node) => {
        if (scrollContainerRef.current && handleNativeWheelRef.current) {
            scrollContainerRef.current.removeEventListener('wheel', handleNativeWheelRef.current);
        }

        scrollContainerRef.current = node;

        if (scrollContainerRef.current) {
            handleNativeWheelRef.current = (e) => {
                e.preventDefault(); // Stop normal scroll natively (requires passive: false)

                // Read synchronous scale ref
                const prevScale = currentScaleRef.current;
                const zoomFactor = 0.05;
                const newScaleRaw = e.deltaY < 0 ? prevScale + zoomFactor : prevScale - zoomFactor;
                const newScale = Math.max(0.2, Math.min(3, newScaleRaw));

                if (newScale === prevScale) return;

                const container = scrollContainerRef.current;
                const scaleContainer = scaleContainerRef.current;

                if (container && scaleContainer) {
                    const rect = container.getBoundingClientRect();

                    // Mouse position relative to the scrollable container viewport
                    const mouseX = e.clientX - rect.left;
                    const mouseY = e.clientY - rect.top;

                    // Mouse position relative to the TOTAL scrolling canvas (including what is scrolled out of view)
                    const absoluteMouseX = mouseX + container.scrollLeft;
                    const absoluteMouseY = mouseY + container.scrollTop;

                    // The proportion of the mouse position relative to the current scale
                    const scaleRatio = newScale / prevScale;

                    // Where that exact pixel *will* be after the new scale is applied
                    const projectedMouseX = absoluteMouseX * scaleRatio;
                    const projectedMouseY = absoluteMouseY * scaleRatio;

                    // The difference we need to scroll to keep that pixel visually under the cursor 
                    const targetScrollLeft = projectedMouseX - mouseX;
                    const targetScrollTop = projectedMouseY - mouseY;

                    // 1. MANUALLY apply CSS transform synchronously for 60fps butter smoothness
                    scaleContainer.style.transform = `scale(${newScale})`;

                    // 2. MANUALLY apply scroll offsets exactly simultaneously
                    container.scrollLeft = targetScrollLeft;
                    container.scrollTop = targetScrollTop;

                    // 3. Update refs and React state in the background to catch up
                    currentScaleRef.current = newScale;
                    setScale(newScale);
                }
            };
            scrollContainerRef.current.addEventListener('wheel', handleNativeWheelRef.current, { passive: false });
        }
    }, []);

    // Create the high-res map view
    useEffect(() => {
        if (!sitePlanFile) return;

        let active = true;
        const objectUrls = [];

        const fetchAllPages = async () => {
            setIsLoadingImage(true);
            setErrorMsg(null);

            try {
                // Fetch page 0 first to get the total count
                const formData = new FormData();
                formData.append('file', sitePlanFile);
                formData.append('page_num', '0');

                const response = await fetch(`${API_BASE}/render-site-plan-hq`, {
                    method: 'POST',
                    body: formData
                });

                if (!response.ok) throw new Error("Failed to render high-res map");

                const totalStr = response.headers.get("X-Total-Pages");
                const total = totalStr ? parseInt(totalStr, 10) : 1;

                if (!active) return;

                setTotalPages(total);
                setLoadingProgress({ current: 1, total });

                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                objectUrls.push(url);
                setPageUrls([...objectUrls]);

                // If there are more pages, fetch them sequentially
                for (let i = 1; i < total; i++) {
                    if (!active) break;

                    const fd = new FormData();
                    fd.append('file', sitePlanFile);
                    fd.append('page_num', i.toString());

                    const res = await fetch(`${API_BASE}/render-site-plan-hq`, {
                        method: 'POST',
                        body: fd
                    });

                    if (res.ok) {
                        const b = await res.blob();
                        const u = URL.createObjectURL(b);
                        objectUrls.push(u);
                        setPageUrls([...objectUrls]);
                    }
                    if (active) setLoadingProgress({ current: i + 1, total });
                }

            } catch (err) {
                console.error(err);
                if (active) setErrorMsg("Could not load high-resolution Site Plan.");
            } finally {
                if (active) setIsLoadingImage(false);
            }
        };

        fetchAllPages();

        return () => {
            active = false;
            objectUrls.forEach(url => URL.revokeObjectURL(url));
        };
    }, [sitePlanFile]);

    const handleCanvasDoubleClick = (e, pageIndex) => {
        if (!activeRecordId || isDragging) return;

        // Find relative coordinates on the image container for the specific sheet
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const relativeX = x / rect.width;
        const relativeY = y / rect.height;

        setPins(prev => ({
            ...prev,
            [activeRecordId]: { _manual_x: relativeX, _manual_y: relativeY, _manual_page: pageIndex }
        }));

        // Auto-advance to next missing pin
        const currentIndex = missingPins.findIndex(p => p._id === activeRecordId);
        if (currentIndex !== -1 && currentIndex < missingPins.length - 1) {
            setActiveRecordId(missingPins[currentIndex + 1]._id);
        }
    };

    const handleMouseDown = (e) => {
        // Prevent middle/right clicks from initiating a drag pan
        if (e.button !== 0) return;
        setIsDragging(true);
        dragPosRef.current = {
            x: e.clientX,
            y: e.clientY,
            left: scrollContainerRef.current.scrollLeft,
            top: scrollContainerRef.current.scrollTop
        };
    };

    const handleMouseMove = (e) => {
        if (!isDragging) return;
        const dx = e.clientX - dragPosRef.current.x;
        const dy = e.clientY - dragPosRef.current.y;
        scrollContainerRef.current.scrollLeft = dragPosRef.current.left - dx;
        scrollContainerRef.current.scrollTop = dragPosRef.current.top - dy;
    };

    const handleMouseUpOrLeave = () => {
        if (isDragging) setIsDragging(false);
    };

    const handleComplete = () => {
        onResolve(pins);
    };

    const handleClearPin = (e, recordId) => {
        e.stopPropagation();
        setPins(prev => {
            const newPins = { ...prev };
            delete newPins[recordId];
            return newPins;
        });
    };

    const handleSearch = async (e) => {
        e.preventDefault();
        if (!searchQuery.trim() || !sitePlanFile) return;

        setIsSearching(true);
        setSearchError(null);
        setSearchResults([]);
        setActiveSearchIndex(-1);

        try {
            const formData = new FormData();
            formData.append('file', sitePlanFile);
            formData.append('query', searchQuery);

            const response = await fetch(`${API_BASE}/search-site-plan`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                // Try to parse error message if it's JSON
                let errorMsg = "Search failed";
                try {
                    const errData = await response.json();
                    errorMsg = errData.detail || errorMsg;
                } catch (e) { }

                if (response.status === 404) {
                    errorMsg = "Backend route not found. Did you restart the Python server?";
                }
                throw new Error(errorMsg);
            }

            const data = await response.json();

            setSearchResults(data.matches || []);
            if (data.matches && data.matches.length > 0) {
                setActiveSearchIndex(0);
                scrollToMatch(0, data.matches);
            } else {
                setSearchError("No matches found.");
            }
        } catch (err) {
            console.error(err);
            setSearchError("Failed to search.");
        } finally {
            setIsSearching(false);
        }
    };

    const scrollToMatch = (index, results = searchResults) => {
        if (index < 0 || index >= results.length) return;
        const match = results[index];
        const pageRef = pageRefs.current[match.page];
        const container = scrollContainerRef.current;

        if (pageRef && container) {
            // Force zoom to 200% if we are currently zoomed out
            const ZOOM_LEVEL = 2.0;
            const targetScale = Math.max(scale, ZOOM_LEVEL);
            if (scale !== targetScale) {
                setScale(targetScale);
            }

            const containerRect = container.getBoundingClientRect();

            // 1. Get raw, unscaled dimensions of the page container
            const unscaledPageWidth = pageRef.offsetWidth;
            const unscaledPageHeight = pageRef.offsetHeight;

            // 2. Get unscaled offsets relative to the scaled flex wrapper
            const unscaledPageTop = pageRef.offsetTop;
            const unscaledPageLeft = pageRef.offsetLeft;

            // 3. Find the exact center of the highlight relative to its page (unscaled)
            const matchCenterY = match.y + (match.h / 2);
            const matchCenterX = match.x + (match.w / 2);

            // 4. Calculate absolute unscaled coordinates of the point from the top-left of the wrapper
            const absUnscaledY = unscaledPageTop + (matchCenterY * unscaledPageHeight);
            const absUnscaledX = unscaledPageLeft + (matchCenterX * unscaledPageWidth);

            // 5. Apply the target scale to project where this point will be in scrolled pixels
            const targetScaledY = absUnscaledY * targetScale;
            const targetScaledX = absUnscaledX * targetScale;

            // 6. Subtract half the container frame to perfectly center the match on screen
            const scrollTargetY = targetScaledY - (containerRect.height / 2);
            const scrollTargetX = targetScaledX - (containerRect.width / 2);

            // Wait specifically for React state to flush the `scale` CSS update before scrolling
            // Otherwise the browser scroll bounds block the calculation
            setTimeout(() => {
                container.scrollTo({
                    top: Math.max(0, scrollTargetY),
                    left: Math.max(0, scrollTargetX),
                    behavior: 'smooth'
                });
            }, 150);
        }
    };

    const handleNextSearch = () => {
        const nextIndex = (activeSearchIndex + 1) % searchResults.length;
        setActiveSearchIndex(nextIndex);
        scrollToMatch(nextIndex);
    };

    const handlePrevSearch = () => {
        const prevIndex = (activeSearchIndex - 1 + searchResults.length) % searchResults.length;
        setActiveSearchIndex(prevIndex);
        scrollToMatch(prevIndex);
    };

    const clearSearch = () => {
        setSearchQuery("");
        setSearchResults([]);
        setActiveSearchIndex(-1);
        setSearchError(null);
    };

    return (
        <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col h-[82vh] bg-white border border-slate-200 shadow-2xl overflow-hidden rounded-xl relative z-10"
        >
            <div className="bg-slate-800 border-b border-slate-700 p-4 flex justify-between items-center px-8 z-30 shrink-0">
                <div className="flex items-center space-x-4">
                    <button onClick={onBack} className="p-2 bg-slate-700/50 hover:bg-slate-700 rounded-lg text-slate-300 transition-colors">
                        <ArrowLeft size={20} />
                    </button>
                    <div>
                        <h3 className="text-base font-bold text-white uppercase tracking-tight flex items-center space-x-2">
                            <Map size={18} className="text-amber-400 mr-2" />
                            Manual Coordinate Resolution
                        </h3>
                        <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                            {missingPins.length} record{missingPins.length !== 1 ? 's' : ''} require manual mapping
                        </p>
                    </div>
                </div>

                <div className="flex justify-end space-x-3">
                    <button
                        onClick={handleComplete}
                        className="bg-emerald-500 hover:bg-emerald-600 text-slate-900 border border-emerald-400 px-6 py-2.5 rounded-lg font-bold uppercase tracking-wider text-[11px] flex items-center shadow-lg transition-all"
                    >
                        <CheckCircle size={16} className="mr-2" />
                        Resume Finalization
                    </button>
                </div>
            </div>

            <div className="flex flex-1 min-h-0 relative">
                {/* LEFT SIDEBAR: Missing Pins List */}
                <div className="w-[380px] bg-slate-50 border-r border-slate-200 flex flex-col shrink-0 overflow-y-auto hidden-scrollbar relative z-20">
                    <div className="p-5 border-b border-slate-200 bg-white sticky top-0 shadow-sm z-30">
                        <h4 className="text-[11px] font-bold text-slate-800 uppercase tracking-widest flex items-center">
                            <AlertTriangle size={14} className="text-amber-500 mr-2" />
                            Unresolved Entities
                        </h4>
                        <p className="text-[10px] text-slate-500 mt-2 leading-relaxed">
                            The automated localized could not pinpoint these records. Select a record below and click on the Site Plan canvas to manually drop a pin.
                        </p>
                    </div>

                    <div className="flex-1 p-3 space-y-2">
                        {missingPins.map((record) => {
                            const isPinned = !!pins[record._id];
                            const isActive = activeRecordId === record._id;
                            const name = record["Signed by"] || record.proprietor_name || "Unknown";
                            const plotNum = record["Plot No"] || record.title_number;

                            let bgColor = "bg-white border-slate-200";
                            let statusText = "Needs Pin";
                            let statusColor = "text-amber-600 bg-amber-50 border-amber-200";

                            if (isPinned) {
                                statusText = "Pinned";
                                statusColor = "text-emerald-700 bg-emerald-50 border-emerald-200";
                            }
                            if (isActive) {
                                bgColor = "bg-blue-50 border-blue-300 ring-2 ring-blue-500/20";
                            }

                            return (
                                <div
                                    key={record._id}
                                    onClick={() => setActiveRecordId(record._id)}
                                    className={`p-4 rounded-xl border cursor-pointer transition-all shadow-sm ${bgColor} hover:shadow-md hover:-translate-y-0.5`}
                                >
                                    <div className="flex justify-between items-start mb-2">
                                        <div className="flex-1 min-w-0 pr-3">
                                            <h5 className="text-[12px] font-bold text-slate-800 truncate" title={name}>{name}</h5>
                                            <p className="text-[10px] text-slate-500 uppercase tracking-wider font-mono mt-0.5 text-blue-600 font-bold bg-blue-50 inline-block px-1.5 py-0.5 rounded">Plot {plotNum || 'N/A'}</p>
                                        </div>
                                        <div className="flex items-center space-x-1 shrink-0">
                                            <div className={`text-[9px] font-bold uppercase px-2 py-1 rounded border overflow-hidden ${statusColor}`}>
                                                {statusText}
                                            </div>
                                            {isPinned && (
                                                <button
                                                    onClick={(e) => handleClearPin(e, record._id)}
                                                    className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                                                    title="Clear Pin"
                                                >
                                                    <X size={14} />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    {record["Phone No"] && (
                                        <div className="text-[10px] text-slate-400 font-mono mt-2 flex items-center">
                                            <span className="opacity-70 mr-2">📱</span> {record["Phone No"]}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* RIGHT CANVAS: The Map */}
                <div className="flex-1 bg-slate-200/50 relative overflow-hidden flex flex-col isolate">
                    {/* Controls Overlay */}
                    <div className="absolute top-4 right-6 z-40 bg-white/90 backdrop-blur border border-slate-200 rounded-xl shadow-xl flex flex-col p-1.5 space-y-2">
                        {/* Zoom Controls */}
                        <div className="flex items-center space-x-1 justify-center border-b border-slate-100 pb-1.5">
                            <button
                                onClick={() => setScale(s => Math.max(0.2, s - 0.2))}
                                className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors"
                            >
                                <ZoomOut size={16} />
                            </button>
                            <div className="px-2 text-[10px] font-bold text-slate-500 font-mono w-14 text-center select-none">
                                {Math.round(scale * 100)}%
                            </div>
                            <button
                                onClick={() => setScale(s => Math.min(3, s + 0.2))}
                                className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors"
                            >
                                <ZoomIn size={16} />
                            </button>
                        </div>

                        {/* Native Search Controls */}
                        <form onSubmit={handleSearch} className="flex items-center space-x-1">
                            <div className="relative flex-1">
                                <Search size={14} className="absolute left-2.5 top-1/2 transform -translate-y-1/2 text-slate-400" />
                                <input
                                    type="text"
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    placeholder="Find in PDF..."
                                    className="w-full pl-8 pr-8 py-1.5 text-[11px] bg-slate-50 border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all font-mono"
                                />
                                {searchQuery && (
                                    <button
                                        type="button"
                                        onClick={clearSearch}
                                        className="absolute right-2 top-1/2 transform -translate-y-1/2 text-slate-400 hover:text-slate-600"
                                    >
                                        <X size={12} />
                                    </button>
                                )}
                            </div>
                            <button
                                type="submit"
                                disabled={isSearching || !searchQuery}
                                className="p-1.5 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded border border-blue-200 disabled:opacity-50 transition-colors"
                            >
                                {isSearching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                            </button>
                        </form>

                        {/* Search Results Navigation */}
                        {searchResults.length > 0 && (
                            <div className="flex items-center justify-between px-1 pt-1 border-t border-slate-100">
                                <span className="text-[10px] font-bold text-slate-500 font-mono">
                                    {activeSearchIndex + 1} / {searchResults.length}
                                </span>
                                <div className="flex space-x-1">
                                    <button
                                        type="button"
                                        onClick={handlePrevSearch}
                                        className="p-1 text-slate-500 hover:bg-slate-100 rounded"
                                    >
                                        <ChevronUp size={14} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleNextSearch}
                                        className="p-1 text-slate-500 hover:bg-slate-100 rounded"
                                    >
                                        <ChevronDown size={14} />
                                    </button>
                                </div>
                            </div>
                        )}
                        {searchError && (
                            <div className="text-[9px] text-red-500 font-bold px-1 text-center">
                                {searchError}
                            </div>
                        )}
                    </div>

                    {isLoadingImage && pageUrls.length === 0 ? (
                        <div className="flex-1 flex flex-col items-center justify-center space-y-4 text-slate-500">
                            <Loader2 size={40} className="animate-spin text-blue-500" />
                            <p className="text-xs uppercase font-bold tracking-widest text-slate-500">Rendering High-Res Cartography...</p>
                        </div>
                    ) : errorMsg ? (
                        <div className="flex-1 flex items-center justify-center text-red-500 font-bold text-sm">
                            {errorMsg}
                        </div>
                    ) : (
                        <div
                            ref={setScrollContainerRef}
                            className={`flex-1 overflow-auto relative bg-[url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAAXNSR0IArs4c6QAAACVJREFUKFNjZCASMDKgAnv37v3/n00xigk1gNQwMo3EaDJS3EIAK4oR84z7yNwAAAAASUVORK5CYII=')] select-none ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
                            onMouseDown={handleMouseDown}
                            onMouseMove={handleMouseMove}
                            onMouseUp={handleMouseUpOrLeave}
                            onMouseLeave={handleMouseUpOrLeave}
                        >
                            <div
                                ref={scaleContainerRef}
                                className="inline-flex flex-col items-center p-8 origin-top-left"
                                style={{ transform: `scale(${scale})`, minWidth: '100%' }}
                            >
                                {pageUrls.map((url, index) => (
                                    <div
                                        key={index}
                                        ref={(el) => pageRefs.current[index] = el}
                                        className="relative mb-8 shadow-[0_10px_40px_-10px_rgba(0,0,0,0.3)] bg-white ring-1 ring-slate-200/50"
                                        onDoubleClick={(e) => handleCanvasDoubleClick(e, index)}
                                    >
                                        <img src={url} alt={`Site Plan Page ${index + 1}`} className="max-w-none select-none pointer-events-none block" />

                                        {/* Page Label */}
                                        <div className="absolute top-4 left-4 bg-slate-900/80 text-white text-[10px] font-bold px-2 py-1 rounded shadow-sm opacity-50 hover:opacity-100 transition-opacity pointer-events-none z-10">
                                            Sheet {index + 1}
                                        </div>

                                        {/* Render dropped pins for THIS page */}
                                        {Object.entries(pins).map(([id, coords]) => {
                                            if (coords._manual_page !== index) return null;
                                            return (
                                                <div
                                                    key={id}
                                                    className="absolute transform -translate-x-1/2 -translate-y-[100%] pointer-events-none drop-shadow-md pb-[2px] z-30"
                                                    style={{
                                                        left: `${coords._manual_x * 100}%`,
                                                        top: `${coords._manual_y * 100}%`
                                                    }}
                                                >
                                                    <MapPin
                                                        size={48 / scale}
                                                        className={`${id === activeRecordId ? 'text-amber-500 animate-bounce' : 'text-emerald-500'}`}
                                                        fill={id === activeRecordId ? '#fcd34d' : '#a7f3d0'}
                                                        strokeWidth={1.5}
                                                    />
                                                </div>
                                            );
                                        })}

                                        {/* Render Search Highlights for THIS page */}
                                        {searchResults.map((match, matchIndex) => {
                                            if (match.page !== index) return null;
                                            const isActiveMatch = matchIndex === activeSearchIndex;
                                            return (
                                                <div
                                                    key={`search-${matchIndex}`}
                                                    className={`absolute pointer-events-none z-20 transition-all duration-300 ${isActiveMatch
                                                        ? 'ring-4 ring-amber-400 bg-amber-400/30'
                                                        : 'ring-2 ring-yellow-300 bg-yellow-300/20'
                                                        }`}
                                                    style={{
                                                        left: `${match.x * 100}%`,
                                                        top: `${match.y * 100}%`,
                                                        width: `${match.w * 100}%`,
                                                        height: `${match.h * 100}%`,
                                                        boxShadow: isActiveMatch ? '0 0 20px 4px rgba(251, 191, 36, 0.4)' : 'none'
                                                    }}
                                                />
                                            );
                                        })}
                                    </div>
                                ))}

                                {isLoadingImage && pageUrls.length > 0 && (
                                    <div className="py-8 flex flex-col items-center text-slate-400">
                                        <Loader2 size={24} className="animate-spin mb-2" />
                                        <span className="text-[10px] uppercase font-bold tracking-widest">
                                            Loading Sheet {loadingProgress.current + 1} of {loadingProgress.total}...
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </motion.div>
    );
};

export default MapPinningView;
