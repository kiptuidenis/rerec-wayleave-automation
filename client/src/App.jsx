import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    Upload,
    FileText,
    CheckCircle,
    ChevronRight,
    Download,
    Edit3,
    Search,
    AlertCircle,
    Loader2,
    Image as ImageIcon,
    Table as TableIcon,
    ShieldCheck,
    Zap,
    FileUp,
    LayoutDashboard,
    Database,
    CircleCheck,
    Maximize2,
    X,
    ZoomIn,
    ZoomOut,
    AlertTriangle,
    RefreshCw
} from 'lucide-react';
import axios from 'axios';
import { HotTable } from '@handsontable/react';
import { registerAllModules } from 'handsontable/registry';
import 'handsontable/dist/handsontable.full.min.css';
import MapPinningView from './components/MapPinningView';

// register Handsontable's modules
try {
    console.log("Registering Handsontable modules...");
    registerAllModules();
    console.log("Handsontable modules registered successfully.");
} catch (e) {
    console.error("Handsontable registration failed:", e);
}

const API_BASE = 'http://localhost:8000';

export default function App() {
    console.log("App component initializing...");
    const [step, setStep] = useState(1);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    // Files State
    // Files State
    const [consentFiles, setConsentFiles] = useState([]);
    const [sitePlanFile, setSitePlanFile] = useState(null);
    const [excelTemplate, setExcelTemplate] = useState(null);
    const [sitePlanWarning, setSitePlanWarning] = useState(null);
    const [isVerifyingSitePlan, setIsVerifyingSitePlan] = useState(false);

    const [results, setResults] = useState([]);
    const [hotData, setHotData] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [isFinalizing, setIsFinalizing] = useState(false);
    const [isExportingExcel, setIsExportingExcel] = useState(false);
    const [previewUrl, setPreviewUrl] = useState(null);
    const [isPreviewLoading, setIsPreviewLoading] = useState(false);
    const [isLightboxOpen, setIsLightboxOpen] = useState(false);
    const [isHoverPreviewOpen, setIsHoverPreviewOpen] = useState(false);
    const [hoverZoom, setHoverZoom] = useState(1);
    const [skippedCount, setSkippedCount] = useState(0);
    const [lightboxZoom, setLightboxZoom] = useState(1);

    // Step 2.5 State
    const [missingPins, setMissingPins] = useState([]);
    const [extractTimeElapsed, setExtractTimeElapsed] = useState(0);
    const [finalizeTimeElapsed, setFinalizeTimeElapsed] = useState(0);
    const [totalPages, setTotalPages] = useState(0);

    const [finalDownloadUrl, setFinalDownloadUrl] = useState(null);
    const [finalFilename, setFinalFilename] = useState("");

    // Hosting the preview zoom logic in a ref to handle non-passive wheel events
    const previewRef = useRef(null);
    const [processedPages, setProcessedPages] = useState({});

    // Timers
    useEffect(() => {
        let timer;
        if (loading) {
            timer = setInterval(() => setExtractTimeElapsed(prev => prev + 1), 1000);
        } else {
            clearInterval(timer);
        }
        return () => clearInterval(timer);
    }, [loading]);

    useEffect(() => {
        let timer;
        if (isFinalizing) {
            timer = setInterval(() => setFinalizeTimeElapsed(prev => prev + 1), 1000);
        } else {
            clearInterval(timer);
        }
        return () => clearInterval(timer);
    }, [isFinalizing]);

    const formatTimer = (totalSeconds) => {
        const m = Math.floor(totalSeconds / 60);
        const s = totalSeconds % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    // Handle mouse wheel zoom with passive: false to prevent page scroll
    useEffect(() => {
        const el = previewRef.current;
        if (!el) return;

        const handleWheel = (e) => {
            if (isHoverPreviewOpen) {
                // This is the critical part to stop page scrolling
                e.preventDefault();
                setHoverZoom(prev => {
                    const delta = e.deltaY > 0 ? -0.2 : 0.2;
                    return Math.min(Math.max(1, prev + delta), 4);
                });
            }
        };

        el.addEventListener('wheel', handleWheel, { passive: false });
        return () => el.removeEventListener('wheel', handleWheel);
    }, [isHoverPreviewOpen]);

    // Close lightbox on Escape key
    useEffect(() => {
        const onKey = (e) => {
            if (e.key === 'Escape') {
                setIsLightboxOpen(false);
                setLightboxZoom(1);
                setIsHoverPreviewOpen(false);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    // Sync Results to HotData
    useEffect(() => {
        if (results.length > 0) {
            console.log("Syncing results to HotData. Results count:", results.length);
            const data = results.map(r => [
                r["Project Name"] || '', // Col 2
                r["Constituency"] || '', // Col 3
                r["County"] || '',       // Col 4
                '',                      // Col 5 (Region)
                '',                      // Col 6 (Affected land)
                r["Plot No"] || '',      // Col 7
                r["Owned by"] || '',     // Col 8
                r["Signed by"] || '',    // Col 9
                r["Relationship"] || '', // Col 10
                r["ID No"] || '',        // Col 11
                r["Phone No"] || '',      // Col 12
                r["Ownership Document"] || 'UNDER ADJUDICATION', // Col 13
                r["Consent Signed"] || 'YES', // Col 14
                r._id // Hidden ID at Index 14
            ]);

            // Only update hotData if it's actually empty or the size changed
            // Otherwise, we let handleHotChange manage the granular updates
            // to avoid re-rendering the whole grid on every keystroke.
            setHotData(prev => {
                if (prev.length === 0 || prev.length !== data.length) {
                    return data;
                }
                // Check if any value changed externally (checking all 13 mapped columns)
                let changed = false;
                for (let i = 0; i < data.length; i++) {
                    for (let j = 0; j < 13; j++) {
                        if (data[i][j] !== prev[i][j]) {
                            changed = true;
                            break;
                        }
                    }
                    if (changed) break;
                }
                return changed ? data : prev;
            });
        } else if (hotData.length > 0) {
            setHotData([]);
        }
    }, [results]);

    // --- EFFECTS ---
    useEffect(() => {
        const abortController = new AbortController();
        let currentUrl = null;

        const fetchPreview = async () => {
            const selected = results.find(r => r._id === selectedId);
            if (!selected) {
                if (previewUrl) {
                    window.URL.revokeObjectURL(previewUrl);
                    setPreviewUrl(null);
                }
                return;
            }

            setIsPreviewLoading(true);
            try {
                const file = consentFiles.find(f => f.name === selected._file_name);
                if (!file) return;

                const formData = new FormData();
                formData.append('file', file);
                formData.append('page_num', selected._page_num);

                const res = await axios.post(`${API_BASE}/preview`, formData, {
                    responseType: 'blob',
                    signal: abortController.signal
                });

                const url = window.URL.createObjectURL(new Blob([res.data]));
                currentUrl = url;

                setPreviewUrl(prev => {
                    if (prev) window.URL.revokeObjectURL(prev);
                    return url;
                });
            } catch (err) {
                if (axios.isCancel(err) || err.name === 'CanceledError' || (err.message && err.message.includes('canceled'))) {
                    console.log('Preview fetch canceled because another row was selected.');
                    if (currentUrl) window.URL.revokeObjectURL(currentUrl);
                } else {
                    console.error("Preview failed", err);
                    setPreviewUrl(prev => {
                        if (prev) window.URL.revokeObjectURL(prev);
                        return null;
                    });
                }
            } finally {
                if (!abortController.signal.aborted) {
                    setIsPreviewLoading(false);
                }
            }
        };

        if (selectedId) fetchPreview();
        else {
            setPreviewUrl(prev => {
                if (prev) window.URL.revokeObjectURL(prev);
                return null;
            });
        }

        return () => {
            abortController.abort();
            setPreviewUrl(prev => {
                if (prev) window.URL.revokeObjectURL(prev);
                return null;
            });
        };
    }, [selectedId, results, consentFiles]);

    useEffect(() => {
        if (!sitePlanFile) {
            setSitePlanWarning(null);
            return;
        }

        const verifySitePlan = async () => {
            setIsVerifyingSitePlan(true);
            setSitePlanWarning(null);
            try {
                const formData = new FormData();
                formData.append('file', sitePlanFile);
                const res = await axios.post(`${API_BASE}/analyze-site-plan`, formData);
                if (!res.data.is_searchable) {
                    setSitePlanWarning(res.data.message);
                }
            } catch (err) {
                console.warn("Failed to analyze site plan", err);
            } finally {
                setIsVerifyingSitePlan(false);
            }
        };

        verifySitePlan();
    }, [sitePlanFile]);

    // --- HANDLERS ---
    // Progress State
    const [progress, setProgress] = useState(0);
    const [statusMsg, setStatusMsg] = useState("");

    const handleExtract = async () => {
        if (consentFiles.length === 0) {
            setError("Please upload at least one consent form.");
            return;
        }

        setLoading(true);
        setError(null);
        setProgress(0);
        setStatusMsg(Object.keys(processedPages).length > 0 ? "Resuming extraction..." : "Initializing extraction...");

        // Don't clear results/skipped if we are resuming
        if (Object.keys(processedPages).length === 0) {
            setResults([]);
            setSkippedCount(0);
            setExtractTimeElapsed(0);
        }

        try {
            const formData = new FormData();
            consentFiles.forEach(file => formData.append('files', file));

            if (Object.keys(processedPages).length > 0) {
                formData.append('processed_pages', JSON.stringify(processedPages));
            }

            const response = await fetch(`${API_BASE}/extract`, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) throw new Error("Server error during extraction");

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            // Start with previously accumulated data if resuming
            let accumulatedResults = [...results];
            let accumulatedSkips = skippedCount;
            let currentProcessedMap = { ...processedPages };

            let buffer = "";

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop(); // Keep partial line in buffer

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const event = JSON.parse(line);

                        if (event.type === 'init') {
                            setStatusMsg(`Extracted ${event.total_pages} pages. Analyzing...`);
                            setTotalPages(event.total_pages);
                        } else if (event.type === 'progress') {
                            const percent = Math.round((event.current / event.total) * 100);
                            setProgress(percent);
                            setStatusMsg(event.status || `Scanned ${event.current} of ${event.total} pages...`);
                        } else if (event.type === 'data') {
                            accumulatedResults.push(event.data);
                            // Track successful page for this file
                            const fName = event.data._file_name;
                            const pNum = event.data._page_num;
                            if (!currentProcessedMap[fName]) currentProcessedMap[fName] = [];
                            currentProcessedMap[fName].push(pNum);
                            setProcessedPages({ ...currentProcessedMap });
                        } else if (event.type === 'skip') {
                            accumulatedSkips++;
                        } else if (event.type === 'file_start') {
                            // Ensure we have an entry for the file to track skips/errors against
                            if (!currentProcessedMap[event.filename]) currentProcessedMap[event.filename] = [];
                        } else if (event.type === 'error') {
                            throw new Error(event.message);
                        } else if (event.type === 'complete') {
                            setResults([...accumulatedResults]);
                            setSkippedCount(accumulatedSkips);
                            setProcessedPages({}); // Clear resume cache on success
                            if (accumulatedResults.length > 0) setSelectedId(accumulatedResults[0]._id);
                            setStep(2);
                        }
                    } catch (e) {
                        console.error("Error parsing stream line:", e);
                    }
                }
            }
        } catch (err) {
            setError(`${err.message || 'Extraction failed'}. You can resume your progress.`);
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    const handleDownloadExcel = async () => {
        if (!excelTemplate) {
            setError("Excel Template is required.");
            return;
        }

        setIsExportingExcel(true);
        setError(null);

        try {
            const formData = new FormData();
            const jsonBlob = new Blob([JSON.stringify(results)], { type: 'application/json' });
            formData.append('extraction_results_file', jsonBlob, 'results.json');
            formData.append('excel_template', excelTemplate);

            const response = await fetch(`${API_BASE}/download-excel`, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) throw new Error("Server error during Excel export");

            const blob = await response.blob();
            const downloadUrl = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = downloadUrl;
            link.setAttribute('download', 'Wayleave_Master_List_Edited.xlsx');
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(downloadUrl);
        } catch (err) {
            console.error("Excel Export Error:", err);
            setError(err.message || "Excel export failed. Please check the server logs.");
        } finally {
            setIsExportingExcel(false);
        }
    };

    const handleFinalize = async (overrideResults = null) => {
        if (!sitePlanFile || !excelTemplate) {
            setError("Site Plan and Excel Template are required.");
            return;
        }

        setIsFinalizing(true);
        setError(null);
        setProgress(0);
        setStatusMsg("Preparing package generation...");
        setFinalizeTimeElapsed(0);

        const dataToSubmit = overrideResults || results;

        try {
            const formData = new FormData();
            const jsonBlob = new Blob([JSON.stringify(dataToSubmit)], { type: 'application/json' });
            formData.append('extraction_results_file', jsonBlob, 'results.json');
            formData.append('site_plan', sitePlanFile);
            formData.append('excel_template', excelTemplate);
            consentFiles.forEach(file => formData.append('consent_pdfs', file));

            const response = await fetch(`${API_BASE}/finalize`, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) throw new Error("Server error during finalization");

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const event = JSON.parse(line);

                        if (event.type === 'status') {
                            setStatusMsg(event.message);
                        } else if (event.type === 'progress') {
                            const percent = Math.round((event.current / event.total) * 100);
                            setProgress(percent);
                            setStatusMsg(event.message);
                            setStep(3); // Linear Flow: Jump to Step 3 visually once stream progresses
                        } else if (event.type === 'missing_pins') {
                            setMissingPins(event.missing_rows);
                            setStep(2.5);
                            return; // Break out! Let user resolve coordinates
                        } else if (event.type === 'error') {
                            throw new Error(event.message);
                        } else if (event.type === 'complete') {
                            const downloadUrl = `${API_BASE}${event.download_url}`;
                            setFinalDownloadUrl(downloadUrl);
                            setFinalFilename(event.filename);
                            setStep(3);
                            setIsFinalizing(false);
                        }
                    } catch (e) {
                        console.error("Error parsing finalization stream line:", e);
                    }
                }
            }
        } catch (err) {
            console.error("Finalization Error:", err);
            setError(err.message || "Finalization failed. Please check the server logs.");
            setIsFinalizing(false);
            setStep(2); // Kick back to step 2 if catastrophic error
        }
    };

    const updateResult = (id, field, value) => {
        setResults(prev => prev.map(r => r._id === id ? { ...r, [field]: value } : r));
    };

    const handleHotChange = function (changes, source) {
        if (!changes || source === 'loadData') return;

        // 'this' refers to the Handsontable instance if defined as function()
        const hot = this;

        setResults(prevResults => {
            const nextResults = [...prevResults];
            let hasChanged = false;

            changes.forEach(([visualRow, prop, oldValue, newValue]) => {
                if (oldValue === newValue) return;

                // CRITICAL FIX: Convert visual row index to physical index (data source index)
                // This is required because columnSorting is enabled.
                const physicalRow = hot.toPhysicalRow(visualRow);

                const colMap = [
                    "Project Name",      // 0
                    "Constituency",      // 1
                    "County",            // 2
                    null,                // 3 (Region)
                    null,                // 4 (Affected land)
                    "Plot No",           // 5
                    "Owned by",          // 6
                    "Signed by",         // 7
                    "Relationship",      // 8
                    "ID No",             // 9
                    "Phone No",          // 10
                    "Ownership Document", // 11
                    "Consent Signed"     // 12
                ];

                const colIndex = parseInt(prop);
                const field = colMap[colIndex];

                if (field && nextResults[physicalRow]) {
                    nextResults[physicalRow] = { ...nextResults[physicalRow], [field]: newValue };
                    hasChanged = true;
                }
            });

            return hasChanged ? nextResults : prevResults;
        });
    };

    const StepIndicator = () => (
        <div className="flex items-center justify-center space-x-4 mb-12">
            {[
                { n: 1, label: 'Upload' },
                { n: 2, label: 'Review' },
                { n: 3, label: 'Generate' }
            ].map((s, idx) => (
                <React.Fragment key={s.n}>
                    <div className="flex items-center group">
                        <div className={`flex items-center justify-center w-8 h-8 rounded-full border-2 transition-all duration-300 font-bold text-xs ${step >= s.n ? 'bg-brand-primary border-brand-primary text-white shadow-md' : 'border-slate-300 text-slate-400 bg-white'
                            }`}>
                            {step > s.n ? <CircleCheck size={16} /> : s.n}
                        </div>
                        <span className={`ml-3 text-xs font-semibold uppercase tracking-wider transition-colors ${step >= s.n ? 'text-brand-primary' : 'text-slate-400'
                            }`}>
                            {s.label}
                        </span>
                    </div>
                    {idx < 2 && <div className={`w-16 h-[2px] rounded-full mx-2 ${step > s.n ? 'bg-brand-primary' : 'bg-slate-200'}`} />}
                </React.Fragment>
            ))}
        </div>
    );

    try {
        return (
            <div className="min-h-screen bg-slate-50 text-slate-900 selection:bg-blue-100 selection:text-blue-900">
                {console.log("Rendering App. Step:", step)}
                {/* Header / Navbar */}
                <nav className="bg-white border-b border-slate-200 sticky top-0 z-50">
                    <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
                        <div className="flex items-center space-x-3">
                            <div className="bg-brand-primary p-2 rounded-xl shadow-md">
                                <ShieldCheck className="text-white" size={24} />
                            </div>
                            <div>
                                <h1 className="text-lg font-bold tracking-tight text-slate-900">Wayleave<span className="text-brand-secondary">Automation</span></h1>
                            </div>
                        </div>
                    </div>
                </nav>

                <div className="max-w-7xl mx-auto px-6 py-10">
                    <StepIndicator />

                    {error && (
                        <motion.div
                            initial={{ opacity: 0, y: -10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="mb-8 p-4 bg-red-50 border border-red-200 rounded-xl flex items-center space-x-4 text-red-700 shadow-sm"
                        >
                            <AlertCircle className="shrink-0" size={20} />
                            <p className="text-sm font-medium">{error}</p>
                        </motion.div>
                    )}

                    {/* Step Transitions */}
                    <div className="relative">
                        {step === 1 && (
                            <motion.div
                                key="step1"
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, scale: 0.98 }}
                                className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start"
                            >
                                {/* Left Side: Configuration Cards */}
                                <div className="lg:col-span-4 space-y-6">
                                    <section className="card-shell p-6 bg-white overflow-hidden relative">
                                        <div className="flex items-center space-x-3 mb-6">
                                            <div className="p-2 bg-blue-50 rounded-lg text-blue-600">
                                                <Database size={20} />
                                            </div>
                                            <h3 className="font-bold text-slate-800 tracking-tight">Project Resources</h3>
                                        </div>
                                        <div className="space-y-4">
                                            <div>
                                                <FileUploadZone
                                                    label="Master Site Plan (PDF)"
                                                    file={sitePlanFile}
                                                    setFile={setSitePlanFile}
                                                    icon={<FileText size={18} />}
                                                />
                                                {isVerifyingSitePlan && <p className="text-[10px] text-blue-500 mt-2 font-bold animate-pulse text-center">Verifying PDF text layer...</p>}
                                                {sitePlanWarning && (
                                                    <motion.div initial={{ opacity: 0, y: -5 }} animate={{ opacity: 1, y: 0 }} className="mt-3 text-left bg-orange-50 border border-orange-200 text-orange-700 text-[10px] p-3 rounded-xl flex items-start space-x-2 shadow-sm">
                                                        <AlertTriangle size={14} className="flex-shrink-0 mt-0.5 text-orange-500" />
                                                        <span className="font-bold leading-relaxed">{sitePlanWarning}</span>
                                                    </motion.div>
                                                )}
                                            </div>
                                            <FileUploadZone
                                                label="Metadata Template (XLSX)"
                                                file={excelTemplate}
                                                setFile={setExcelTemplate}
                                                icon={<TableIcon size={18} />}
                                            />
                                        </div>
                                        <p className="mt-6 text-[11px] text-slate-400 font-medium leading-relaxed">
                                            Upload the project's site plan and the Excel schema template to begin the automated extraction process.
                                        </p>
                                    </section>
                                </div>

                                {/* Right Side: Payload Dropzone */}
                                <div className="lg:col-span-8">
                                    <div className="card-shell p-8 bg-white h-full flex flex-col">
                                        <div className="mb-8">
                                            <h3 className="text-xl font-bold text-slate-900 tracking-tight flex items-center space-x-3">
                                                <FileUp className="text-brand-primary" size={24} />
                                                <span>Document Payload</span>
                                            </h3>
                                            <p className="text-sm text-slate-500 mt-1">Select scanned consent forms for processing and metadata extraction.</p>
                                        </div>

                                        {consentFiles.length === 0 ? (
                                            <label className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-slate-200 rounded-2xl p-12 hover:bg-slate-50 hover:border-brand-primary/40 transition-all cursor-pointer group mb-6 bg-slate-50/50">
                                                <input type="file" multiple className="hidden" onChange={(e) => {
                                                    setConsentFiles(Array.from(e.target.files));
                                                    setProcessedPages({}); // Reset resume state when files change
                                                }} />
                                                <div className="bg-white p-4 rounded-full shadow-sm border border-slate-200 group-hover:scale-110 transition-transform duration-300 mb-4">
                                                    <Upload className="text-slate-400 group-hover:text-brand-primary" size={32} />
                                                </div>
                                                <p className="text-slate-900 font-bold text-lg">Click to Upload Documents</p>
                                                <p className="text-slate-400 text-xs mt-2 uppercase tracking-widest font-bold">Standard PDF Format Only</p>
                                            </label>
                                        ) : (
                                            <label className="flex flex-row items-center justify-center space-x-2 border-2 border-dashed border-slate-200 rounded-xl py-3 hover:bg-slate-50 hover:border-brand-primary/40 transition-all cursor-pointer group mb-6 bg-slate-50/50">
                                                <input type="file" multiple className="hidden" onChange={(e) => {
                                                    setConsentFiles(Array.from(e.target.files));
                                                    setProcessedPages({});
                                                }} />
                                                <Upload className="text-slate-400 group-hover:text-brand-primary transition-colors" size={16} />
                                                <p className="text-slate-600 font-semibold text-sm group-hover:text-brand-primary transition-colors">Select different documents</p>
                                            </label>
                                        )}

                                        {consentFiles.length > 0 && (
                                            <div className="bg-blue-50/50 rounded-xl p-4 border border-blue-100 mb-8 items-center flex justify-between">
                                                <div className="flex items-center space-x-3">
                                                    <div className="w-8 h-8 rounded-lg bg-white border border-blue-200 flex items-center justify-center text-blue-600 font-bold text-xs shadow-sm">
                                                        {consentFiles.length}
                                                    </div>
                                                    <span className="text-xs font-bold text-blue-800 uppercase tracking-wider">Documents Ready for Extraction</span>
                                                </div>
                                                <div className="flex -space-x-2">
                                                    {consentFiles.slice(0, 3).map((_, i) => (
                                                        <div key={i} className="w-6 h-6 rounded-full border-2 border-white bg-slate-200" />
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        <button
                                            onClick={handleExtract}
                                            disabled={loading || consentFiles.length === 0}
                                            className="w-full bg-brand-primary hover:bg-slate-800 text-white font-bold py-4 rounded-xl flex flex-col items-center justify-center transition-all shadow-lg hover:shadow-xl active:transform active:scale-[0.99] disabled:opacity-40 overflow-hidden relative"
                                        >
                                            {loading ? (
                                                <div className="w-full px-8 flex flex-col items-center">
                                                    <div className="flex items-center space-x-3 mb-2 font-medium">
                                                        <Loader2 className="animate-spin text-white" size={18} />
                                                        <span className="text-sm text-white drop-shadow-sm">{statusMsg}</span>
                                                    </div>
                                                    <div className="w-full h-1.5 bg-white/30 rounded-full overflow-hidden shadow-inner">
                                                        <motion.div
                                                            className="h-full bg-white shadow-sm"
                                                            initial={{ width: 0 }}
                                                            animate={{ width: `${progress}%` }}
                                                            transition={{ duration: 0.5 }}
                                                        />
                                                    </div>
                                                    <div className="flex justify-between w-full mt-1.5">
                                                        <span className="text-[10px] text-white/90 uppercase tracking-widest font-bold drop-shadow-sm">{progress}% Complete</span>
                                                        <span className="text-[10px] text-white/90 uppercase tracking-widest font-bold font-mono drop-shadow-sm">{formatTimer(extractTimeElapsed)}</span>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="flex items-center space-x-3">
                                                    {Object.keys(processedPages).length > 0 ? (
                                                        <>
                                                            <RefreshCw size={20} />
                                                            <span>Resume Extraction</span>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <Search size={20} />
                                                            <span>Extract to Spreadsheet</span>
                                                        </>
                                                    )}
                                                </div>
                                            )}
                                        </button>
                                    </div>
                                </div>
                            </motion.div>
                        )}

                        {step === 2 && (
                            <motion.div
                                key="step2"
                                initial={{ opacity: 0, scale: 0.98 }}
                                animate={{ opacity: 1, scale: 1 }}
                                className="card-shell overflow-hidden h-[82vh] flex flex-col bg-white border-slate-200 shadow-2xl relative"
                            >
                                {console.log("Rendering Step 2. hotData length:", hotData.length)}
                                {/* Toolbar */}
                                <div className="bg-slate-50 border-b border-slate-200 p-4 flex justify-between items-center px-8 z-30">
                                    <div className="flex items-center space-x-4">
                                        <div className="p-2 bg-blue-50 rounded-lg text-blue-600">
                                            <LayoutDashboard size={20} />
                                        </div>
                                        <div>
                                            <h3 className="text-sm font-bold text-slate-800 uppercase tracking-tight">Metadata Validation Grid</h3>
                                            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">{results.length} Entities Identified â€¢ Real-time Sync Active</p>
                                        </div>
                                    </div>
                                    <div className="flex items-center space-x-4">
                                        <button
                                            onClick={() => setStep(1)}
                                            className="text-slate-500 hover:text-slate-800 text-[10px] font-bold uppercase tracking-widest transition-all px-4 py-2"
                                        >
                                            Back to Upload
                                        </button>
                                        <button
                                            onClick={handleDownloadExcel}
                                            disabled={isExportingExcel || results.length === 0}
                                            className="bg-white border border-slate-200 text-slate-700 px-6 py-2.5 rounded-lg font-bold uppercase tracking-wider text-[11px] flex items-center justify-center min-w-[150px] shadow-sm hover:bg-slate-50 transition-all disabled:opacity-50"
                                        >
                                            {isExportingExcel ? (
                                                <div className="flex items-center space-x-2">
                                                    <Loader2 className="animate-spin" size={12} />
                                                    <span>Exporting...</span>
                                                </div>
                                            ) : (
                                                <div className="flex items-center space-x-2">
                                                    <Download size={16} />
                                                    <span>Download Excel</span>
                                                </div>
                                            )}
                                        </button>
                                        <button
                                            onClick={() => handleFinalize()}
                                            disabled={isFinalizing}
                                            className="bg-brand-primary hover:bg-slate-800 disabled:opacity-50 text-white px-6 py-2.5 rounded-lg font-bold uppercase tracking-wider text-[11px] flex items-center justify-center min-w-[180px] shadow-sm transition-all"
                                        >
                                            {isFinalizing ? (
                                                <div className="flex items-center space-x-2">
                                                    <Loader2 className="animate-spin" size={16} />
                                                    <span>Analyzing Coordinates...</span>
                                                </div>
                                            ) : (
                                                <div className="flex items-center space-x-2">
                                                    <ShieldCheck size={16} />
                                                    <span>Generate Package</span>
                                                </div>
                                            )}
                                        </button>
                                    </div>
                                </div>

                                {skippedCount > 0 && (
                                    <div className="bg-amber-50 border-b border-amber-200 px-8 py-3 flex items-center space-x-3 text-amber-800 shrink-0 z-20 shadow-sm relative">
                                        <AlertCircle size={16} className="text-amber-600" />
                                        <div className="text-xs font-medium">
                                            <span className="font-bold">{skippedCount} page{skippedCount > 1 ? 's' : ''} skipped:</span> Not recognized as Wayleave Consent Forms.
                                        </div>
                                    </div>
                                )}

                                <div className="flex-1 flex min-h-0 bg-white shadow-inner" style={{ overflow: 'hidden' }}>
                                    {/* Handsontable: The Exact Excel UI */}
                                    <div className="flex-1 bg-white relative border-r border-slate-200" style={{ overflow: 'hidden' }}>
                                        {hotData.length > 0 ? (
                                            <HotTable
                                                data={hotData}
                                                colHeaders={[
                                                    'Project',
                                                    'Constituency',
                                                    'County',
                                                    'Region',
                                                    'Affected Land',
                                                    'Plot No',
                                                    'Owned By',
                                                    'Proprietor (Signer)',
                                                    'Relationship',
                                                    'ID No',
                                                    'Phone',
                                                    'Ownership Doc',
                                                    'Consent',
                                                    '_id'
                                                ]}
                                                columns={[
                                                    { type: 'text' }, { type: 'text' }, { type: 'text' },
                                                    { type: 'text', readOnly: true }, { type: 'text', readOnly: true },
                                                    { type: 'text' }, { type: 'text' }, { type: 'text' },
                                                    { type: 'text' }, { type: 'text' }, { type: 'text' },
                                                    { type: 'text' }, { type: 'text' },
                                                    { type: 'text', readOnly: true, editor: false }
                                                ]}
                                                hiddenColumns={{
                                                    columns: [13],
                                                    indicators: false
                                                }}
                                                height={Math.floor(window.innerHeight * 0.72)}
                                                width="100%"
                                                licenseKey="non-commercial-and-evaluation"
                                                rowHeaders={true}
                                                rowHeights={40}
                                                columnSorting={true}
                                                contextMenu={true}
                                                manualColumnResize={true}
                                                manualRowResize={true}
                                                autoWrapCol={true}
                                                autoWrapRow={true}
                                                stretchH="all"
                                                fillHandle={true} // Enable drag-to-fill
                                                afterChange={handleHotChange}
                                                afterSelectionEnd={function (row) {
                                                    // Get the exact data array for the row sitting at this visual index
                                                    const rowData = this.getSourceDataAtRow(this.toPhysicalRow(row));
                                                    if (rowData && rowData[13]) { // Index 13 is the hidden _id
                                                        setSelectedId(rowData[13]);
                                                    }
                                                }}
                                                viewportRowRenderingOffset={10}
                                                className="corporate-hot"
                                            />
                                        ) : (
                                            <div className="flex flex-col items-center justify-center h-full text-slate-400 space-y-4" style={{ minHeight: '400px' }}>
                                                <Loader2 className="animate-spin" size={32} />
                                                <p className="text-xs font-bold uppercase tracking-widest">Initialising Grid Data...</p>
                                            </div>
                                        )}
                                    </div>

                                    {/* Preview Panel */}
                                    <div className="w-[450px] bg-slate-50 border-l border-slate-200 p-6 flex flex-col relative z-20">
                                        <div className="flex items-center justify-between mb-4">
                                            <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Document Evidence</h4>
                                            <div className="flex items-center space-x-2">
                                                {previewUrl && (
                                                    <button
                                                        onClick={() => { setIsLightboxOpen(true); setLightboxZoom(1); }}
                                                        className="flex items-center space-x-1.5 bg-brand-primary hover:bg-blue-800 text-white px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all shadow-sm"
                                                    >
                                                        <Maximize2 size={11} />
                                                        <span>Full View</span>
                                                    </button>
                                                )}
                                                <div className="bg-white px-3 py-1 rounded-md border border-slate-200 text-[9px] font-bold text-slate-600 shadow-sm">
                                                    {previewUrl ? 'SYNCED' : 'AWAITING'}
                                                </div>
                                            </div>
                                        </div>

                                        <div
                                            ref={previewRef}
                                            className="flex-1 rounded-xl overflow-hidden border border-slate-200 bg-slate-200/50 flex items-center justify-center relative shadow-inner"
                                            onMouseEnter={() => previewUrl && setIsHoverPreviewOpen(true)}
                                            onMouseLeave={() => {
                                                setIsHoverPreviewOpen(false);
                                                setHoverZoom(1);
                                            }}
                                        >
                                            {isPreviewLoading ? (
                                                <div className="flex flex-col items-center space-y-4">
                                                    <Loader2 size={32} className="text-brand-primary animate-spin" />
                                                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Loading Evidence...</p>
                                                </div>
                                            ) : previewUrl ? (
                                                <motion.img
                                                    key={selectedId}
                                                    initial={{ opacity: 0 }}
                                                    animate={{ opacity: 1 }}
                                                    src={previewUrl}
                                                    alt="Source Evidence"
                                                    className="w-full h-full object-contain"
                                                />
                                            ) : (
                                                <div className="text-center p-8">
                                                    <div className="bg-white/50 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-slate-100">
                                                        <ImageIcon size={32} className="text-slate-300" />
                                                    </div>
                                                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 max-w-[160px] mx-auto leading-relaxed">
                                                        Select a row to view the original document source
                                                    </p>
                                                </div>
                                            )}
                                        </div>

                                        <AnimatePresence>
                                            {isHoverPreviewOpen && previewUrl && (
                                                <motion.div
                                                    initial={{ opacity: 0, scale: 0.9 }}
                                                    animate={{ opacity: 1, scale: 1 }}
                                                    exit={{ opacity: 0, scale: 0.9 }}
                                                    transition={{ type: "spring", damping: 25, stiffness: 300 }}
                                                    // This box sits right over the original but is slightly larger due to negative margins
                                                    // It stays on the right because it's absolute to the sidebar
                                                    className="absolute -inset-10 bg-white rounded-2xl shadow-[0_40px_80px_-15px_rgba(0,0,0,0.5)] border border-slate-200 z-[100] p-4 pointer-events-none flex items-center justify-center overflow-hidden"
                                                >
                                                    <motion.img
                                                        layout
                                                        src={previewUrl}
                                                        alt="Hover Zoom Evidence"
                                                        className="w-full h-full object-contain rounded-xl"
                                                        animate={{ scale: hoverZoom }}
                                                        transition={{ duration: 0.1 }}
                                                    />
                                                </motion.div>
                                            )}
                                        </AnimatePresence>

                                        <div className="mt-4 p-4 bg-white rounded-lg border border-slate-200 shadow-sm">
                                            <p className="text-[9px] text-slate-400 font-bold uppercase tracking-widest mb-1">Source File</p>
                                            <p className="text-[11px] font-bold text-slate-700 truncate">
                                                {results.find(r => r._id === selectedId)?._file_name || 'No file selected'}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            </motion.div>
                        )}

                        {/* LIGHTBOX MODAL */}
                        <AnimatePresence>
                            {isLightboxOpen && previewUrl && (
                                <motion.div
                                    key="lightbox"
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    transition={{ duration: 0.18 }}
                                    className="fixed inset-0 z-[9999] flex items-center justify-center"
                                    onClick={() => { setIsLightboxOpen(false); setLightboxZoom(1); }}
                                >
                                    <div className="absolute inset-0 bg-slate-900/85 backdrop-blur-md" />

                                    <div className="absolute top-6 left-1/2 -translate-x-1/2 z-10 flex items-center space-x-3 bg-white/10 backdrop-blur-sm border border-white/20 rounded-2xl px-4 py-2 shadow-2xl">
                                        <span className="text-[10px] font-bold text-white/70 uppercase tracking-widest truncate max-w-[200px]">
                                            {results.find(r => r._id === selectedId)?._file_name || 'Document'}
                                        </span>
                                        <div className="w-px h-4 bg-white/20" />
                                        <button onClick={(e) => { e.stopPropagation(); setLightboxZoom(z => Math.max(0.5, z - 0.25)); }} className="text-white/80 hover:text-white p-1.5 rounded-lg hover:bg-white/10 transition-all"><ZoomOut size={16} /></button>
                                        <span className="text-[11px] font-bold text-white min-w-[40px] text-center">{Math.round(lightboxZoom * 100)}%</span>
                                        <button onClick={(e) => { e.stopPropagation(); setLightboxZoom(z => Math.min(4, z + 0.25)); }} className="text-white/80 hover:text-white p-1.5 rounded-lg hover:bg-white/10 transition-all"><ZoomIn size={16} /></button>
                                        <div className="w-px h-4 bg-white/20" />
                                        <button onClick={(e) => { e.stopPropagation(); setIsLightboxOpen(false); setLightboxZoom(1); }} className="text-white/80 hover:text-white p-1.5 rounded-lg hover:bg-white/10 transition-all"><X size={16} /></button>
                                    </div>

                                    <motion.div
                                        className="relative z-10 flex items-center justify-center w-full h-full p-20"
                                        onClick={(e) => e.stopPropagation()}
                                        initial={{ scale: 0.92, opacity: 0 }}
                                        animate={{ scale: 1, opacity: 1 }}
                                        exit={{ scale: 0.95, opacity: 0 }}
                                        transition={{ duration: 0.18 }}
                                    >
                                        <img
                                            src={previewUrl}
                                            alt="Document Fullscreen View"
                                            style={{
                                                transform: `scale(${lightboxZoom})`,
                                                transformOrigin: 'center center',
                                                transition: 'transform 0.2s ease',
                                                maxWidth: '100%',
                                                maxHeight: '100%',
                                                objectFit: 'contain',
                                                borderRadius: '8px',
                                                boxShadow: '0 25px 60px rgba(0,0,0,0.5)',
                                            }}
                                        />
                                    </motion.div>

                                    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[10px] font-bold text-white/40 uppercase tracking-widest">
                                        Press Esc or click backdrop to close
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        {step === 2.5 && (
                            <MapPinningView
                                missingPins={missingPins}
                                sitePlanFile={sitePlanFile}
                                onBack={() => {
                                    setStep(2);
                                    setIsFinalizing(false);
                                }}
                                onResolve={(pins) => {
                                    // Apply pins to the results state
                                    const newResults = results.map(r => {
                                        if (pins[r._id]) {
                                            return { ...r, ...pins[r._id] };
                                        }
                                        return r;
                                    });
                                    setResults(newResults);
                                    setStep(3); // Linear Flow: Jump instantly to the loading step visually
                                    handleFinalize(newResults); // Go straight to generating step
                                }}
                            />
                        )}

                        {step === 3 && (
                            <motion.div
                                key="step3"
                                initial={{ opacity: 0, y: 30 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="max-w-xl mx-auto text-center py-20"
                            >
                                <div className="card-shell p-12 bg-white relative overflow-hidden">
                                    <div className="absolute top-0 left-0 w-full h-1.5 bg-brand-primary" />

                                    {isFinalizing ? (
                                        <div className="py-8">
                                            <div className="bg-blue-50 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-8 text-blue-600 shadow-sm border border-blue-100">
                                                <Loader2 size={40} className="animate-spin" />
                                            </div>
                                            <h2 className="text-2xl font-bold text-slate-900 mb-2 tracking-tight animate-pulse">Generating Distribution Package</h2>
                                            <p className="text-slate-500 mb-10 leading-relaxed font-medium text-sm">
                                                {statusMsg}
                                            </p>

                                            <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden mb-3">
                                                <motion.div
                                                    className="h-full bg-brand-primary"
                                                    initial={{ width: 0 }}
                                                    animate={{ width: `${progress}%` }}
                                                />
                                            </div>
                                            <div className="flex justify-between w-full">
                                                <span className="text-[10px] text-slate-400 uppercase tracking-widest font-bold">Progress: {progress}%</span>
                                                <span className="text-[10px] text-slate-400 uppercase tracking-widest font-bold font-mono">Elapsed: {formatTimer(finalizeTimeElapsed)}</span>
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <div className="bg-blue-50 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-8 text-blue-600 shadow-sm border border-blue-100">
                                                <CheckCircle size={40} />
                                            </div>
                                            <h2 className="text-3xl font-bold text-slate-900 mb-4 tracking-tight">Processing Complete</h2>
                                            <p className="text-slate-500 mb-8 leading-relaxed font-medium">
                                                Your wayleave automation package has been generated successfully. All metadata has been extracted, validated, and bundled into a final distribution archive.
                                            </p>

                                            <div className="grid grid-cols-2 gap-4 mb-10">
                                                <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 shadow-sm text-center flex flex-col justify-center">
                                                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Total Processing Time</p>
                                                    <p className="text-2xl font-black text-slate-800 tracking-tight font-mono">{formatTimer(extractTimeElapsed + finalizeTimeElapsed)}</p>
                                                </div>
                                                <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 shadow-sm text-center flex flex-col justify-center">
                                                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Total Pages Processed</p>
                                                    <p className="text-2xl font-black text-slate-800 tracking-tight font-mono">{totalPages}</p>
                                                </div>
                                            </div>

                                            <div className="flex flex-col space-y-4">
                                                {finalDownloadUrl && (
                                                    <button
                                                        onClick={() => {
                                                            const link = document.createElement('a');
                                                            link.href = finalDownloadUrl;
                                                            link.setAttribute('download', finalFilename || 'Wayleave_Automation_Results.zip');
                                                            document.body.appendChild(link);
                                                            link.click();
                                                            document.body.removeChild(link);
                                                        }}
                                                        className="w-full bg-slate-900 hover:bg-black text-white font-bold py-4 rounded-xl flex items-center justify-center space-x-3 transition-all shadow-md"
                                                    >
                                                        <Download size={20} />
                                                        <span>Download Package</span>
                                                    </button>
                                                )}
                                                <button
                                                    onClick={() => window.location.reload()}
                                                    className="w-full bg-brand-primary hover:bg-blue-800 text-white font-bold py-4 rounded-xl flex items-center justify-center space-x-3 transition-all shadow-md"
                                                >
                                                    <Zap size={20} />
                                                    <span>Initialize New Project</span>
                                                </button>
                                            </div>
                                        </>
                                    )}
                                </div>
                            </motion.div>
                        )}
                    </div>
                </div>
            </div>
        );
    } catch (err) {
        console.error("App Render Error:", err);
        return (
            <div className="min-h-screen bg-slate-50 flex items-center justify-center p-10">
                <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-red-100 p-10 text-center">
                    <div className="bg-red-50 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6 text-red-600">
                        <AlertCircle size={32} />
                    </div>
                    <h1 className="text-xl font-bold text-slate-900 mb-2">Application Error</h1>
                    <p className="text-sm text-slate-500 mb-6">
                        The application encountered a critical error during rendering. Please check the browser console for details.
                    </p>
                    <div className="bg-slate-50 rounded-lg p-4 text-left border border-slate-200 mb-6">
                        <p className="text-[10px] font-mono text-red-600 break-all">{err.message}</p>
                    </div>
                    <button
                        onClick={() => window.location.reload()}
                        className="w-full bg-slate-900 text-white py-3 rounded-xl font-bold text-sm"
                    >
                        Try Refreshing
                    </button>
                </div>
            </div>
        );
    }
}

function FileUploadZone({ label, file, setFile, icon }) {
    return (
        <div className="space-y-2">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-1">{label}</span>
            <label className={`flex items-center space-x-4 p-4 rounded-xl border-2 border-dashed transition-all cursor-pointer bg-slate-50/50 ${file ? 'border-blue-200 bg-blue-50/30' : 'border-slate-200 hover:border-brand-primary/40 hover:bg-slate-50'
                }`}>
                <input type="file" className="hidden" onChange={(e) => setFile(e.target.files[0])} />
                <div className={`p-2.5 rounded-lg shadow-sm border ${file ? 'bg-white border-blue-100 text-blue-600' : 'bg-white border-slate-100 text-slate-400'
                    }`}>
                    {file ? <CheckCircle size={18} /> : icon}
                </div>
                <div className="flex-1 min-w-0">
                    <p className={`text-[11px] font-bold truncate ${file ? 'text-blue-800' : 'text-slate-500 uppercase tracking-wider'}`}>
                        {file ? file.name : 'Select File'}
                    </p>
                    {file && <p className="text-[9px] text-blue-600 font-bold uppercase tracking-widest mt-0.5">Ready for Sync</p>}
                </div>
            </label>
        </div>
    );
}

