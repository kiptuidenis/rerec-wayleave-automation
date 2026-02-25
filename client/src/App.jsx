import React, { useState, useEffect } from 'react';
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
    ZoomOut
} from 'lucide-react';
import axios from 'axios';
import { HotTable } from '@handsontable/react';
import { registerAllModules } from 'handsontable/registry';
import 'handsontable/dist/handsontable.full.min.css';

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
    const [consentFiles, setConsentFiles] = useState([]);
    const [sitePlanFile, setSitePlanFile] = useState(null);
    const [excelTemplate, setExcelTemplate] = useState(null);

    const [results, setResults] = useState([]);
    const [hotData, setHotData] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [isFinalizing, setIsFinalizing] = useState(false);
    const [previewUrl, setPreviewUrl] = useState(null);
    const [isPreviewLoading, setIsPreviewLoading] = useState(false);
    const [isLightboxOpen, setIsLightboxOpen] = useState(false);
    const [lightboxZoom, setLightboxZoom] = useState(1);

    // Close lightbox on Escape key
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') { setIsLightboxOpen(false); setLightboxZoom(1); } };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    // Sync Results to HotData
    useEffect(() => {
        if (results.length > 0) {
            console.log("Syncing results to HotData. Results count:", results.length);
            const data = results.map(r => [
                r["Project Name"] || '',
                r["Signed by"] || '',
                r["Plot No"] || '',
                r["Owned by"] || '',
                r["Constituency"] || '',
                r["County"] || '',
                r["ID No"] || '',
                r["Consent Signed"] || 'YES',
                r["Relationship"] || '',
                r["Phone No"] || ''
            ]);

            // Only update hotData if it's actually empty or the size changed
            // Otherwise, we let handleHotChange manage the granular updates
            // to avoid re-rendering the whole grid on every keystroke.
            setHotData(prev => {
                if (prev.length === 0 || prev.length !== data.length) {
                    return data;
                }
                // Check if any value changed externally
                let changed = false;
                for (let i = 0; i < data.length; i++) {
                    for (let j = 0; j < data[i].length; j++) {
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
        const fetchPreview = async () => {
            const selected = results.find(r => r._id === selectedId);
            if (!selected) return;

            setIsPreviewLoading(true);
            try {
                const file = consentFiles.find(f => f.name === selected._file_name);
                if (!file) return;

                const formData = new FormData();
                formData.append('file', file);
                formData.append('page_num', selected._page_num);

                const res = await axios.post(`${API_BASE}/preview`, formData, {
                    responseType: 'blob'
                });

                if (previewUrl) window.URL.revokeObjectURL(previewUrl);
                const url = window.URL.createObjectURL(new Blob([res.data]));
                setPreviewUrl(url);
            } catch (err) {
                console.error("Preview failed", err);
                setPreviewUrl(null);
            } finally {
                setIsPreviewLoading(false);
            }
        };

        if (selectedId) fetchPreview();
        else setPreviewUrl(null);
    }, [selectedId, results, consentFiles]);

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
        setStatusMsg("Initializing extraction...");
        setResults([]);

        try {
            const formData = new FormData();
            consentFiles.forEach(file => formData.append('files', file));

            const response = await fetch(`${API_BASE}/extract`, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) throw new Error("Server error during extraction");

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let accumulatedResults = [];
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
                        } else if (event.type === 'progress') {
                            const percent = Math.round((event.current / event.total) * 100);
                            setProgress(percent);
                            setStatusMsg(`Analyzing Page ${event.page} of ${event.total}...`);
                        } else if (event.type === 'data') {
                            accumulatedResults.push(event.data);
                            // Optionally update results partially for "live" appearance, 
                            // but usually safer to wait for complete to avoid grid flickering.
                        } else if (event.type === 'error') {
                            throw new Error(event.message);
                        } else if (event.type === 'complete') {
                            setResults([...accumulatedResults]);
                            if (accumulatedResults.length > 0) setSelectedId(accumulatedResults[0]._id);
                            setStep(2);
                        }
                    } catch (e) {
                        console.error("Error parsing stream line:", e);
                    }
                }
            }
        } catch (err) {
            setError(err.message || "Extraction failed. Ensure the backend is running.");
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    const handleFinalize = async () => {
        if (!sitePlanFile || !excelTemplate) {
            setError("Site Plan and Excel Template are required.");
            return;
        }

        setIsFinalizing(true);
        setError(null);
        setProgress(0);
        setStatusMsg("Preparing package generation...");

        try {
            const formData = new FormData();
            formData.append('extraction_results', JSON.stringify(results));
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
                        } else if (event.type === 'error') {
                            throw new Error(event.message);
                        } else if (event.type === 'complete') {
                            // Automatic download
                            const downloadUrl = `${API_BASE}${event.download_url}`;
                            const link = document.createElement('a');
                            link.href = downloadUrl;
                            link.setAttribute('download', event.filename);
                            document.body.appendChild(link);
                            link.click();
                            document.body.removeChild(link);

                            setStep(3);
                        }
                    } catch (e) {
                        console.error("Error parsing finalization stream line:", e);
                    }
                }
            }
        } catch (err) {
            console.error("Finalization Error:", err);
            setError(err.message || "Finalization failed. Please check the server logs.");
        } finally {
            setIsFinalizing(false);
        }
    };

    const updateResult = (id, field, value) => {
        setResults(prev => prev.map(r => r._id === id ? { ...r, [field]: value } : r));
    };

    const handleHotChange = (changes, source) => {
        if (!changes || source === 'loadData') return;

        setResults(prevResults => {
            const nextResults = [...prevResults];
            let hasChanged = false;

            changes.forEach(([row, prop, oldValue, newValue]) => {
                if (oldValue === newValue) return;

                // Map prop (which is the index in hotData) to field name
                const colMap = [
                    "Project Name",
                    "Signed by",
                    "Plot No",
                    "Owned by",
                    "Constituency",
                    "County",
                    "ID No",
                    "Consent Signed",
                    "Relationship",
                    "Phone No"
                ];

                // Handsontable can give 'prop' as a string or number depending on config
                // In our case it's the index because data is an array of arrays
                const colIndex = parseInt(prop);
                const field = colMap[colIndex];

                if (field && nextResults[row]) {
                    nextResults[row] = { ...nextResults[row], [field]: newValue };
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
                            <div className="bg-brand-primary p-1.5 rounded-lg shadow-sm">
                                <ShieldCheck className="text-white" size={24} />
                            </div>
                            <div>
                                <h1 className="text-lg font-bold tracking-tight text-slate-900">Wayleave<span className="text-brand-secondary">Automation</span></h1>
                                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider -mt-1">Corporate Infrastructure</p>
                            </div>
                        </div>
                        <div className="flex items-center space-x-4">
                            <div className="flex items-center space-x-2 bg-slate-100 px-3 py-1.5 rounded-full border border-slate-200">
                                <div className="w-2 h-2 rounded-full bg-blue-500" />
                                <span className="text-[10px] font-bold text-slate-600 uppercase tracking-widest">Server Online</span>
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
                                            <FileUploadZone
                                                label="Master Site Plan (PDF)"
                                                file={sitePlanFile}
                                                setFile={setSitePlanFile}
                                                icon={<FileText size={18} />}
                                            />
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

                                        <label className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-slate-200 rounded-2xl p-12 hover:bg-slate-50 hover:border-brand-primary/40 transition-all cursor-pointer group mb-6 bg-slate-50/50">
                                            <input type="file" multiple className="hidden" onChange={(e) => setConsentFiles(Array.from(e.target.files))} />
                                            <div className="bg-white p-4 rounded-full shadow-sm border border-slate-200 group-hover:scale-110 transition-transform duration-300 mb-4">
                                                <Upload className="text-slate-400 group-hover:text-brand-primary" size={32} />
                                            </div>
                                            <p className="text-slate-900 font-bold text-lg">Click to Upload Documents</p>
                                            <p className="text-slate-400 text-xs mt-2 uppercase tracking-widest font-bold">Standard PDF Format Only</p>
                                        </label>

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
                                            className="w-full bg-brand-primary hover:bg-blue-800 text-white font-bold py-4 rounded-xl flex flex-col items-center justify-center transition-all shadow-md active:transform active:scale-[0.99] disabled:opacity-40 overflow-hidden relative"
                                        >
                                            {loading ? (
                                                <div className="w-full px-8 flex flex-col items-center">
                                                    <div className="flex items-center space-x-3 mb-2">
                                                        <Loader2 className="animate-spin" size={18} />
                                                        <span className="text-sm">{statusMsg}</span>
                                                    </div>
                                                    <div className="w-full h-1.5 bg-white/20 rounded-full overflow-hidden">
                                                        <motion.div
                                                            className="h-full bg-white"
                                                            initial={{ width: 0 }}
                                                            animate={{ width: `${progress}%` }}
                                                            transition={{ duration: 0.5 }}
                                                        />
                                                    </div>
                                                    <span className="text-[10px] mt-1 opacity-70 uppercase tracking-widest font-bold">{progress}% Complete</span>
                                                </div>
                                            ) : (
                                                <div className="flex items-center space-x-3">
                                                    <Search size={20} />
                                                    <span>Begin Cognitive Extraction</span>
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
                                        <div className="p-2 bg-emerald-50 rounded-lg text-emerald-600">
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
                                            onClick={handleFinalize}
                                            disabled={isFinalizing}
                                            className="bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-2.5 rounded-lg font-bold uppercase tracking-wider text-[11px] flex items-center justify-center min-w-[180px] shadow-sm transition-all relative overflow-hidden"
                                        >
                                            {isFinalizing ? (
                                                <div className="w-full flex flex-col items-center">
                                                    <div className="flex items-center space-x-2 mb-1">
                                                        <Loader2 className="animate-spin" size={12} />
                                                        <span className="text-[9px] truncate max-w-[140px]">{statusMsg}</span>
                                                    </div>
                                                    <div className="w-full h-1 bg-white/20 rounded-full overflow-hidden">
                                                        <motion.div
                                                            className="h-full bg-white"
                                                            initial={{ width: 0 }}
                                                            animate={{ width: `${progress}%` }}
                                                        />
                                                    </div>
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

                                <div className="flex-1 flex min-h-0 bg-white shadow-inner" style={{ overflow: 'hidden' }}>
                                    {/* Handsontable: The Exact Excel UI */}
                                    <div className="flex-1 bg-white relative border-r border-slate-200" style={{ overflow: 'hidden' }}>
                                        {hotData.length > 0 ? (
                                            <HotTable
                                                data={hotData}
                                                colHeaders={[
                                                    'Project',
                                                    'Proprietor (Signer)',
                                                    'Plot No',
                                                    'Owned By',
                                                    'Constituency',
                                                    'County',
                                                    'ID No',
                                                    'Consent',
                                                    'Relationship',
                                                    'Phone'
                                                ]}
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
                                                    // Use getSourceDataAtRow to get the true index when sorted
                                                    const sourceData = this.getSourceDataAtRow(row);
                                                    // In our array-of-arrays case, we need to find the result object 
                                                    // that matches this data, or simply find the index in original results
                                                    // Simplified: results and original hotData share indexes
                                                    const visualIndex = row;
                                                    const logicalRow = this.toPhysicalRow(visualIndex);
                                                    if (results[logicalRow]) {
                                                        setSelectedId(results[logicalRow]._id);
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
                                    <div className="w-[450px] bg-slate-50 border-l border-slate-200 p-6 flex flex-col relative overflow-hidden">
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
                                            className={`flex-1 rounded-xl overflow-hidden border border-slate-200 bg-slate-200/50 flex items-center justify-center relative group shadow-inner ${previewUrl ? 'cursor-zoom-in' : ''}`}
                                            onClick={() => previewUrl && (setIsLightboxOpen(true), setLightboxZoom(1))}
                                        >
                                            {isPreviewLoading ? (
                                                <div className="flex flex-col items-center space-y-4">
                                                    <Loader2 size={32} className="text-brand-primary animate-spin" />
                                                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Loading Evidence...</p>
                                                </div>
                                            ) : previewUrl ? (
                                                <>
                                                    <motion.img
                                                        key={selectedId}
                                                        initial={{ opacity: 0 }}
                                                        animate={{ opacity: 1 }}
                                                        src={previewUrl}
                                                        alt="Source Evidence"
                                                        className="w-full h-full object-contain"
                                                    />
                                                    <div className="absolute inset-0 bg-brand-primary/0 group-hover:bg-brand-primary/10 transition-all flex items-center justify-center">
                                                        <div className="opacity-0 group-hover:opacity-100 transition-all bg-white/90 backdrop-blur-sm rounded-full px-4 py-2 flex items-center space-x-2 shadow-lg">
                                                            <Maximize2 size={14} className="text-brand-primary" />
                                                            <span className="text-[10px] font-bold text-slate-700 uppercase tracking-wider">Click to expand</span>
                                                        </div>
                                                    </div>
                                                </>
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

                        {step === 3 && (
                            <motion.div
                                key="step3"
                                initial={{ opacity: 0, y: 30 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="max-w-xl mx-auto text-center py-20"
                            >
                                <div className="card-shell p-12 bg-white relative overflow-hidden">
                                    <div className="absolute top-0 left-0 w-full h-1.5 bg-brand-primary" />
                                    <div className="bg-emerald-50 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-8 text-emerald-600 shadow-sm border border-emerald-100">
                                        <CheckCircle size={40} />
                                    </div>
                                    <h2 className="text-3xl font-bold text-slate-900 mb-4 tracking-tight">Processing Complete</h2>
                                    <p className="text-slate-500 mb-10 leading-relaxed font-medium">
                                        Your wayleave automation package has been generated successfully. All metadata has been extracted, validated, and bundled into a final distribution archive.
                                    </p>
                                    <div className="flex flex-col space-y-4">
                                        <button
                                            onClick={() => window.location.reload()}
                                            className="w-full bg-brand-primary hover:bg-blue-800 text-white font-bold py-4 rounded-xl flex items-center justify-center space-x-3 transition-all shadow-md"
                                        >
                                            <Zap size={20} />
                                            <span>Initialize New Project</span>
                                        </button>
                                    </div>
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
            <label className={`flex items-center space-x-4 p-4 rounded-xl border-2 border-dashed transition-all cursor-pointer bg-slate-50/50 ${file ? 'border-emerald-200 bg-emerald-50/30' : 'border-slate-200 hover:border-brand-primary/40 hover:bg-slate-50'
                }`}>
                <input type="file" className="hidden" onChange={(e) => setFile(e.target.files[0])} />
                <div className={`p-2.5 rounded-lg shadow-sm border ${file ? 'bg-white border-emerald-100 text-emerald-600' : 'bg-white border-slate-100 text-slate-400'
                    }`}>
                    {file ? <CheckCircle size={18} /> : icon}
                </div>
                <div className="flex-1 min-w-0">
                    <p className={`text-[11px] font-bold truncate ${file ? 'text-emerald-800' : 'text-slate-500 uppercase tracking-wider'}`}>
                        {file ? file.name : 'Select File'}
                    </p>
                    {file && <p className="text-[9px] text-emerald-600 font-bold uppercase tracking-widest mt-0.5">Ready for Sync</p>}
                </div>
            </label>
        </div>
    );
}

