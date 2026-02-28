import React, { useState, useEffect, useRef } from 'react';
import { Loader2, ZoomIn, ZoomOut, CheckCircle, ArrowLeft, MapPin, Map, AlertTriangle } from 'lucide-react';
import { motion } from 'framer-motion';

const API_BASE = "http://localhost:8000";

const MapPinningView = ({ missingPins, sitePlanFile, onResolve, onBack }) => {
    const [hqImageUrl, setHqImageUrl] = useState(null);
    const [isLoadingImage, setIsLoadingImage] = useState(true);
    const [errorMsg, setErrorMsg] = useState(null);
    const [activeRecordId, setActiveRecordId] = useState(missingPins.length > 0 ? missingPins[0]._id : null);
    const [pins, setPins] = useState({}); // { _id: { x: float, y: float } }
    const [scale, setScale] = useState(1);

    // Create the high-res map view
    useEffect(() => {
        if (!sitePlanFile) return;

        const fetchHqMap = async () => {
            setIsLoadingImage(true);
            try {
                const formData = new FormData();
                formData.append('file', sitePlanFile);
                formData.append('page_num', '0');

                const response = await fetch(`${API_BASE}/render-site-plan-hq`, {
                    method: 'POST',
                    body: formData
                });

                if (!response.ok) throw new Error("Failed to render high-res map");

                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                setHqImageUrl(url);
            } catch (err) {
                console.error(err);
                setErrorMsg("Could not load high-resolution Site Plan.");
            } finally {
                setIsLoadingImage(false);
            }
        };
        fetchHqMap();

        return () => {
            if (hqImageUrl) URL.revokeObjectURL(hqImageUrl);
        };
    }, [sitePlanFile]);

    const handleCanvasClick = (e) => {
        if (!activeRecordId) return;

        // Find relative coordinates on the image
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const relativeX = x / rect.width;
        const relativeY = y / rect.height;

        setPins(prev => ({
            ...prev,
            [activeRecordId]: { _manual_x: relativeX, _manual_y: relativeY }
        }));

        // Auto-advance to next missing pin
        const currentIndex = missingPins.findIndex(p => p._id === activeRecordId);
        if (currentIndex !== -1 && currentIndex < missingPins.length - 1) {
            setActiveRecordId(missingPins[currentIndex + 1]._id);
        }
    };

    const handleComplete = () => {
        onResolve(pins);
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
                                        <div className={`text-[9px] font-bold uppercase px-2 py-1 rounded border overflow-hidden shrink-0 ${statusColor}`}>
                                            {statusText}
                                        </div>
                                    </div>
                                    {record["Phone No"] && (
                                        <div className="text-[10px] text-slate-400 font-mono mt-2 flex items-center">
                                            <span className="opacity-70 mr-2">ðŸ“±</span> {record["Phone No"]}
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
                    <div className="absolute top-4 right-6 z-40 bg-white/90 backdrop-blur border border-slate-200 rounded-xl shadow-xl flex items-center p-1.5 space-x-1">
                        <button
                            onClick={() => setScale(s => Math.max(0.2, s - 0.2))}
                            className="p-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                        >
                            <ZoomOut size={16} />
                        </button>
                        <div className="px-2 text-[10px] font-bold text-slate-500 font-mono w-14 text-center select-none">
                            {Math.round(scale * 100)}%
                        </div>
                        <button
                            onClick={() => setScale(s => Math.min(3, s + 0.2))}
                            className="p-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                        >
                            <ZoomIn size={16} />
                        </button>
                    </div>

                    {isLoadingImage ? (
                        <div className="flex-1 flex flex-col items-center justify-center space-y-4 text-slate-500">
                            <Loader2 size={40} className="animate-spin text-blue-500" />
                            <p className="text-xs uppercase font-bold tracking-widest text-slate-500">Rendering High-Res Cartography...</p>
                        </div>
                    ) : errorMsg ? (
                        <div className="flex-1 flex items-center justify-center text-red-500 font-bold text-sm">
                            {errorMsg}
                        </div>
                    ) : (
                        <div className="flex-1 overflow-auto relative custom-scrollbar bg-[url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAAXNSR0IArs4c6QAAACVJREFUKFNjZCASMDKgAnv37v3/n00xigk1gNQwMo3EaDJS3EIAK4oR84z7yNwAAAAASUVORK5CYII=')]">
                            <div
                                className="inline-block relative origin-top-left cursor-crosshair drop-shadow-2xl transition-transform duration-200 ease-out"
                                style={{ transform: `scale(${scale})` }}
                                onClick={handleCanvasClick}
                            >
                                <img src={hqImageUrl} alt="High Res Site Plan" className="max-w-none select-none pointer-events-none block" />

                                {/* Render dropped pins */}
                                {Object.entries(pins).map(([id, coords]) => (
                                    <div
                                        key={id}
                                        className="absolute transform -translate-x-1/2 -translate-y-[100%] pointer-events-none drop-shadow-md pb-[2px]"
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
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </motion.div>
    );
};

export default MapPinningView;
