import os
import sys
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import fitz
from thefuzz import fuzz
import jellyfish
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

def test_old_fuzz(target, candidates):
    print(f"\n--- OLD LOGIC (thefuzz) --- Target: '{target}'")
    for cand in candidates:
        ratio = fuzz.ratio(target.lower(), cand.lower())
        partial = fuzz.partial_token_set_ratio(target.lower(), cand.lower())
        print(f"vs '{cand}': Ratio={ratio}%, Partial Token={partial}%")

def test_new_hybrid(target, candidates):
    print(f"\n--- NEW LOGIC (Hybrid TF-IDF + Phonetic) --- Target: '{target}'")
    
    import re
    target_parts = [p for p in target.lower().split() if len(p) > 2]
    target_phonetics = [jellyfish.match_rating_codex(re.sub(r'[^a-zA-Z]', '', p)) for p in target_parts if re.sub(r'[^a-zA-Z]', '', p)]
    
    try:
        vectorizer = TfidfVectorizer(analyzer='char_wb', ngram_range=(2, 3))
        tfidf_matrix = vectorizer.fit_transform([target] + candidates)
    except ValueError as e:
        print("Vectorizer failed:", e)
        return
        
    target_vector = tfidf_matrix[0:1]
    page_vectors = tfidf_matrix[1:]
    cosine_similarities = cosine_similarity(target_vector, page_vectors).flatten()
    
    for idx, n_gram_score in enumerate(cosine_similarities):
        cand = candidates[idx]
        candidate_parts = cand.lower().split()
        
        phonetic_matches = 0
        for t_phonetic in target_phonetics:
            for c_part in candidate_parts:
                clean_c = re.sub(r'[^a-zA-Z]', '', c_part)
                if clean_c and jellyfish.match_rating_codex(clean_c) == t_phonetic:
                    phonetic_matches += 1
                    break

                
        phonetic_score = (phonetic_matches / len(target_phonetics)) if target_phonetics else 0
        fused_score = (phonetic_score * 0.7) + (n_gram_score * 0.3)
        
        print(f"vs '{cand}': FUSED SCORE = {fused_score*100:.1f}% (N-Gram: {n_gram_score:.2f}, Phonetic: {phonetic_score:.2f})")

def main():
    target1 = "Elizabeth Jepkogei"
    cands1 = ["ELIZABETH KIBOGY", "Eliza beth jekogei", "MANUM KIPJEGO RODGERS", "EL1ZAB TH JEPK0GEI", "John Doe"]
    
    test_old_fuzz(target1, cands1)
    test_new_hybrid(target1, cands1)
    
    # Test specific map case
    from server.workflow_lib import SitePlanLocator
    print("\n--- ACTUAL MAP TEST ---")
    locator = SitePlanLocator("SINENDET VILLAGE_merged_removed.pdf")
    
    print("\nTesting 'Elizabeth Jepkogei' (Should match ELIZABETH KIBOGY)")
    res1 = locator.search("Elizabeth Jepkogei", "316") # 316 is missing, so it relies on name
    print(f"Result: {res1}")
    
    print("\nTesting 'Manum Kipjego Rodgers' (Was missing before)")
    res2 = locator.search("Manum Kipjego Rodgers", "317") 
    print(f"Result: {res2}")

if __name__ == "__main__":
    main()
